import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/adapter";
import { createApp } from "../../src/server/app";
import { seedDb } from "../helpers/seed";
import { type TmpHome, tmpHome } from "../helpers/tmp-home";

let h: TmpHome;
let db: Db;
beforeEach(() => {
	h = tmpHome();
	db = seedDb();
});
afterEach(() => {
	db.close();
	h.cleanup();
});

const app = (uiDir = "/nonexistent") => createApp(db, { port: 4242, uiDir });
const HOST = { host: "localhost:4242" };

describe("security middleware", () => {
	it("accepts 127.0.0.1 and localhost hosts", async () => {
		for (const host of ["127.0.0.1:4242", "localhost:4242"])
			expect((await app().request("/api/status", { headers: { host } })).status).toBe(200);
	});

	it("rejects other hosts with 421", async () => {
		for (const host of [
			"evil.example:4242",
			"192.168.1.5:4242",
			"localhost:9999",
			"127.0.0.1",
			"localhost.evil:4242",
		]) {
			const r = await app().request("/api/status", { headers: { host } });
			expect(r.status, host).toBe(421);
			expect(await r.json()).toEqual({ error: { code: "misdirected_request", message: expect.any(String) } });
		}
	});

	it("accepts the bare host on port 80, where browsers leave the port out", async () => {
		const on80 = createApp(db, { port: 80, uiDir: "/nonexistent" });
		for (const host of ["127.0.0.1", "localhost", "127.0.0.1:80"])
			expect((await on80.request("/api/status", { headers: { host } })).status, host).toBe(200);
		expect((await on80.request("/api/status", { headers: { host: "evil.example" } })).status).toBe(421);
		const write = (origin: string) =>
			on80.request("/api/x", {
				method: "POST",
				headers: { host: "localhost", origin, "content-type": "application/json" },
				body: "{}",
			});
		expect((await write("http://localhost")).status).toBe(404); // passes the checks; no such route
		expect((await write("http://evil.example")).status).toBe(403);
	});

	it("rejects a request with no Host header", async () => {
		expect((await app().request("/api/status")).status).toBe(421);
	});

	it("rejects cross-origin writes and non-JSON bodies with 403", async () => {
		const base = { method: "POST", headers: { ...HOST, "content-type": "application/json" } };
		expect(
			(
				await app().request("/api/nudges/x/dismiss", {
					...base,
					headers: { ...base.headers, origin: "https://evil.example" },
				})
			).status,
		).toBe(403);
		expect(
			(await app().request("/api/nudges/x/dismiss", { ...base, headers: { ...HOST, "content-type": "text/plain" } }))
				.status,
		).toBe(403);
		expect((await app().request("/api/nudges/x/dismiss", { method: "PUT", headers: HOST })).status).toBe(403);
		expect(
			(
				await app().request("/api/x", {
					method: "DELETE",
					headers: { ...HOST, "content-type": "application/json", origin: "null" },
				})
			).status,
		).toBe(403);
	});

	it("lets a same-origin or origin-less JSON write through to routing", async () => {
		for (const origin of [undefined, "http://localhost:4242", "http://127.0.0.1:4242"]) {
			const headers: Record<string, string> = { ...HOST, "content-type": "application/json; charset=utf-8" };
			if (origin) headers.origin = origin;
			const r = await app().request("/api/nudges/x/dismiss", { method: "POST", headers, body: "{}" });
			expect(r.status, origin).toBe(404); // no such route in Phase 2
		}
	});

	it("sends no CORS headers", async () => {
		const r = await app().request("/api/status", { headers: { ...HOST, origin: "http://localhost:4242" } });
		expect(r.headers.get("access-control-allow-origin")).toBeNull();
		const pre = await app().request("/api/status", {
			method: "OPTIONS",
			headers: { ...HOST, origin: "https://evil.example", "access-control-request-method": "POST" },
		});
		expect(pre.headers.get("access-control-allow-origin")).toBeNull();
		expect(pre.headers.get("access-control-allow-methods")).toBeNull();
	});

	it("answers unknown API paths with a JSON 404", async () => {
		const r = await app().request("/api/nope", { headers: HOST });
		expect(r.status).toBe(404);
		expect(await r.json()).toEqual({ error: { code: "not_found", message: expect.any(String) } });
	});
});

describe("static UI", () => {
	let ui: string;
	beforeEach(() => {
		ui = join(h.home, "..", "ui");
		mkdirSync(join(ui, "assets"), { recursive: true });
		writeFileSync(join(ui, "index.html"), "<!doctype html><title>cc-debrief</title>");
		writeFileSync(join(ui, "assets", "x.js"), "console.log(1)");
		writeFileSync(join(h.home, "..", "secret.txt"), "secret");
	});

	it("serves index.html at / and for client routes (SPA fallback)", async () => {
		for (const path of ["/", "/sessions", "/sessions/abc", "/skills?tab=mcp", "/repos/github.com%2FOrg%2FRepo"]) {
			const r = await app(ui).request(path, { headers: HOST });
			expect(r.status, path).toBe(200);
			expect(r.headers.get("content-type")).toMatch(/^text\/html/);
			expect(await r.text()).toContain("<title>cc-debrief</title>");
		}
	});

	it("serves a built asset with its content type", async () => {
		const r = await app(ui).request("/assets/x.js", { headers: HOST });
		expect(r.status).toBe(200);
		expect(r.headers.get("content-type")).toMatch(/^text\/javascript/);
		expect(await r.text()).toBe("console.log(1)");
	});

	it("never serves a file outside uiDir", async () => {
		for (const path of [
			"/assets/../../etc/passwd",
			"/assets/%2e%2e/%2e%2e/secret.txt",
			"/..%2fsecret.txt",
			"/assets/..%5c..%5csecret.txt",
		]) {
			const r = await app(ui).request(path, { headers: HOST });
			expect(r.status, path).toBe(404);
			expect(await r.text()).not.toContain("secret");
		}
	});

	it("404s a missing asset instead of returning index.html", async () => {
		expect((await app(ui).request("/assets/missing.js", { headers: HOST })).status).toBe(404);
	});
});

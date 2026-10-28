// Local-only (feature 14): capture never opens a network connection. Every way out of the process that Node
// offers is stubbed to record the call, then the hook (all events), ingest, snapshot and enrich run.
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setConfigValue } from "../../src/config";
import type { Db } from "../../src/db/adapter";
import { enrichSession, snapshotSession } from "../../src/enrich";
import { runHook } from "../../src/hook/run";
import { ingestPending } from "../../src/ingest/ingest";
import { copyFixtureInto, hookFixtures, loadFixtureCases } from "../helpers/fixtures";
import { gitRepo, type TestRepo } from "../helpers/git-repo";
import { seedDb } from "../helpers/seed";
import { type TmpHome, tmpHome } from "../helpers/tmp-home";

let h: TmpHome;
let db: Db;
let repo: TestRepo;
let calls: string[];
beforeEach(() => {
	h = tmpHome();
	setConfigValue("retention.days", "0");
	db = seedDb();
	repo = gitRepo();
	repo.commit({ "README.md": "# app\n" }, "2026-09-29T09:00:00Z");
	calls = [];
	const record =
		(what: string) =>
		(...args: unknown[]) => {
			calls.push(`${what} ${JSON.stringify(args[0])?.slice(0, 120)}`);
			throw new Error(`network call blocked: ${what}`);
		};
	vi.spyOn(net.Socket.prototype, "connect").mockImplementation(record("net.Socket.connect") as never);
	vi.spyOn(http, "request").mockImplementation(record("http.request") as never);
	vi.spyOn(https, "request").mockImplementation(record("https.request") as never);
	vi.spyOn(dns, "lookup").mockImplementation(record("dns.lookup") as never);
	vi.spyOn(globalThis, "fetch").mockImplementation(record("fetch") as never);
});
afterEach(() => {
	vi.restoreAllMocks();
	db.close();
	repo.cleanup();
	h.cleanup();
});

describe("no network during capture", () => {
	it("hook, ingest, snapshot and enrich make no network call", async () => {
		for (const f of hookFixtures()) await runHook(f.raw, {}, db, { spawn: () => {} });
		for (const c of loadFixtureCases()) copyFixtureInto(h.claude, c.caseDir);
		const r = ingestPending(db);
		expect(r.sessions.length).toBeGreaterThan(5);
		const id = r.sessions[0];
		await snapshotSession(db, id, repo.root);
		await enrichSession(db, id, { ai: false });
		expect(calls).toEqual([]);
	});

	it("the stubs do catch a connection attempt", () => {
		expect(() => fetch("https://example.com")).toThrow("network call blocked");
		expect(() => net.connect(80, "example.com")).toThrow("network call blocked");
		expect(calls).toHaveLength(2);
	});
});

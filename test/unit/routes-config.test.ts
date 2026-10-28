import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema, setConfigValue } from "../../src/config";
import type { Db } from "../../src/db/adapter";
import { configPath } from "../../src/paths";
import { DEFAULT_REDACT } from "../../src/redact";
import { createApp } from "../../src/server/app";
import type { ConfigResponse, SelfUsage } from "../../src/server/types";
import { seedDb } from "../helpers/seed";
import { seedSummarizable } from "../helpers/seed-summary";
import { type TmpHome, tmpHome } from "../helpers/tmp-home";

const HOST = { host: "127.0.0.1:4242" };
const JSON_HEADERS = { ...HOST, "content-type": "application/json" };

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

const app = () => createApp(db, { port: 4242, uiDir: "/x" });
const get = async <T>(path: string) => {
	const r = await app().request(path, { headers: HOST });
	return { status: r.status, body: (await r.json()) as T };
};
const send = async (method: string, path: string, body: unknown, headers: Record<string, string> = JSON_HEADERS) => {
	const r = await app().request(path, { method, headers, body: JSON.stringify(body) });
	return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};

describe("GET /api/config", () => {
	it("returns the effective config, defaults, explicit keys and counters", async () => {
		setConfigValue("ai.maxPerDay", "20");
		setConfigValue("capture.redact", '["@default","/ACME-\\\\d+/g"]');
		seedSummarizable(db, h.claude, "pending-1");
		db.prepare("INSERT INTO ai_calls (feature, ts) VALUES ('summary', ?), ('review', ?)").run(
			new Date().toISOString(),
			new Date().toISOString(),
		);
		const { status, body } = await get<ConfigResponse>("/api/config");
		expect(status).toBe(200);
		expect(body.config.ai.maxPerDay).toBe(20);
		expect(body.defaults).toEqual(ConfigSchema.parse({}));
		expect(body.explicit.sort()).toEqual(["ai.maxPerDay", "capture.redact"]);
		expect(body.path).toBe(configPath());
		expect(body.errors).toEqual([]);
		expect(body.defaultRedactCount).toBe(DEFAULT_REDACT.length);
		expect(body.demotedRules).toEqual([]);
		expect(body.usedToday).toEqual({ summaries: 1, reviews: 1 });
		expect(body.pendingSummaries).toBe(1);
		expect(body.dataDir).toBe(h.home);
		expect(body.dbBytes).toBeGreaterThan(0);
		expect(body.estimates).toHaveProperty("summaryUsd");
	});

	it("reports config.json errors", async () => {
		writeFileSync(configPath(), JSON.stringify({ retention: { days: -5 } }));
		const { body } = await get<ConfigResponse>("/api/config");
		expect(body.errors).toEqual([{ key: "retention.days", message: expect.any(String) }]);
		expect(body.config.retention.days).toBe(90);
	});
});

describe("PUT /api/config", () => {
	it("applies a valid change and writes the same sparse file the CLI writes", async () => {
		const r = await send("PUT", "/api/config", { set: { "ai.summaries.enabled": false, "retention.days": 30 } });
		expect(r.status).toBe(200);
		expect(r.body.changed).toEqual(["ai.summaries.enabled", "retention.days"]);
		expect((r.body.config as { retention: { days: number } }).retention.days).toBe(30);
		expect(JSON.parse(readFileSync(configPath(), "utf8"))).toEqual({
			ai: { summaries: { enabled: false } },
			retention: { days: 30 },
		});
	});

	it("unsets a key", async () => {
		setConfigValue("ai.model", "haiku");
		const r = await send("PUT", "/api/config", { unset: ["ai.model"] });
		expect(r.status).toBe(200);
		expect((r.body.config as { ai: { model?: string } }).ai.model).toBeUndefined();
	});

	it("rejects invalid values with 422 and per-field errors, leaving the file unchanged", async () => {
		setConfigValue("retention.days", "60");
		const before = readFileSync(configPath(), "utf8");
		const r = await send("PUT", "/api/config", {
			set: { "ai.maxPerDay": -1, "dashboard.port": 80, "retention.days": 10 },
		});
		expect(r.status).toBe(422);
		const err = r.body.error as { code: string; fields: { key: string; message: string }[] };
		expect(err.code).toBe("invalid_config");
		expect(err.fields.map((f) => f.key).sort()).toEqual(["ai.maxPerDay", "dashboard.port"]);
		expect(readFileSync(configPath(), "utf8")).toBe(before);
	});

	it("rejects an unknown key with 422", async () => {
		const r = await send("PUT", "/api/config", { set: { "ai.nope": 1 } });
		expect(r.status).toBe(422);
		expect((r.body.error as { fields: { key: string }[] }).fields[0].key).toBe("ai.nope");
	});

	it("rejects a malformed body with 422", async () => {
		const r = await send("PUT", "/api/config", { set: "x" });
		expect(r.status).toBe(422);
	});

	it("keeps a hand edit made after the page loaded for keys it does not touch", async () => {
		await get("/api/config");
		writeFileSync(configPath(), JSON.stringify({ dashboard: { port: 5000 } }));
		await send("PUT", "/api/config", { set: { "ai.maxPerDay": 7 } });
		expect(JSON.parse(readFileSync(configPath(), "utf8"))).toEqual({ dashboard: { port: 5000 }, ai: { maxPerDay: 7 } });
	});

	it("refuses a cross-origin write", async () => {
		const r = await send(
			"PUT",
			"/api/config",
			{ set: { "ai.maxPerDay": 7 } },
			{
				...JSON_HEADERS,
				origin: "https://evil.example",
			},
		);
		expect(r.status).toBe(403);
	});
});

describe("GET /api/self-usage", () => {
	it("returns the summary for the range", async () => {
		db.prepare("INSERT INTO self_usage (feature, session_id, cost_usd, ts) VALUES ('summary', 'f', 0.5, ?)").run(
			new Date(Date.now() - 10 * 86_400_000).toISOString(),
		);
		expect((await get<SelfUsage>("/api/self-usage?range=7d")).body.total.calls).toBe(0);
		const month = await get<SelfUsage>("/api/self-usage?range=30d");
		expect(month.body.range).toBe("30d");
		expect(month.body.total.calls).toBe(1);
		expect((await get("/api/self-usage?range=1y")).status).toBe(400);
	});
});

describe("nudges", () => {
	it("dismissal persists across a new app, reset clears it", async () => {
		expect((await send("POST", "/api/nudges/overview/dismiss", {})).body).toEqual({ ok: true });
		const footer = async () =>
			(await get<{ footer: { nudgeDismissed: boolean } }>("/api/improvements")).body.footer.nudgeDismissed;
		expect(await footer()).toBe(true);
		expect((await send("POST", "/api/nudges/nope/dismiss", {})).status).toBe(404);
		expect((await send("POST", "/api/nudges/reset", {})).body).toEqual({ ok: true });
		expect(await footer()).toBe(false);
	});
});

describe("GET /api/config/retention-preview", () => {
	it("counts the sessions the next retention run would delete with that value", async () => {
		for (const [id, age] of [
			["a", 100],
			["b", 40],
			["c", 5],
		] as const) {
			db.prepare("INSERT INTO sessions (session_id, started_at) VALUES (?, ?)").run(
				id,
				new Date(Date.now() - age * 86_400_000).toISOString(),
			);
		}
		expect((await get("/api/config/retention-preview?days=90")).body).toEqual({ sessions: 1 });
		expect((await get("/api/config/retention-preview?days=30")).body).toEqual({ sessions: 2 });
		expect((await get("/api/config/retention-preview?days=0")).body).toEqual({ sessions: 0 });
		expect((await get("/api/config/retention-preview?days=x")).status).toBe(400);
	});
});

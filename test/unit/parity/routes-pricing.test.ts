// Phase 7 Task 4 (P7): the Settings "Pricing" data in GET /api/config and the re-price job a pricing change starts.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PRICE_TABLE, PRICE_TABLE_VERSION } from "../../../src/collector/prices";
import type { Db } from "../../../src/db/adapter";
import { stalePriceSessions } from "../../../src/derive/reprice";
import { deriveSession } from "../../../src/derive/session";
import { createApp } from "../../../src/server/app";
import { waitForRepriceJob } from "../../../src/server/jobs";
import type { ConfigResponse } from "../../../src/server/types";
import { seedDb, storeLines } from "../../helpers/seed";
import { type TmpHome, tmpHome } from "../../helpers/tmp-home";

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

const app = () => createApp(db, { port: 4242, uiDir: "/nonexistent" });
const headers = { host: "localhost:4242", origin: "http://localhost:4242", "content-type": "application/json" };
const getConfig = async () => (await (await app().request("/api/config", { headers })).json()) as ConfigResponse;
const put = (body: unknown) => app().request("/api/config", { method: "PUT", headers, body: JSON.stringify(body) });

describe("GET /api/config pricing", () => {
	it("shows the table date, the built-in rows and no re-price job", async () => {
		const c = await getConfig();
		expect(c.pricing.tableVersion).toBe(PRICE_TABLE_VERSION);
		expect(c.pricing.effectiveVersion).toBe(PRICE_TABLE_VERSION);
		expect(c.pricing.builtIn).toHaveLength(Object.keys(PRICE_TABLE).length);
		expect(c.pricing.builtIn[0]).toEqual({ model: expect.any(String), ...PRICE_TABLE[c.pricing.builtIn[0].model] });
		expect(c.pricing.repricing).toBeNull();
		expect(c.config.pricing.overrides).toEqual({});
	});
});

describe("PUT /api/config pricing.overrides", () => {
	it("saves the overrides, changes the effective version and re-prices derived sessions", async () => {
		storeLines(db, "s1", [
			{ type: "user", uuid: "u1", timestamp: "2026-10-01T10:00:00.000Z", message: { role: "user", content: "x" } },
			{
				type: "assistant",
				uuid: "a1",
				timestamp: "2026-10-01T10:00:01.000Z",
				requestId: "r1",
				message: {
					id: "m1",
					model: "claude-sonnet-4-5",
					role: "assistant",
					content: [{ type: "text", text: "y" }],
					usage: { input_tokens: 1_000_000, output_tokens: 0 },
				},
			},
		]);
		deriveSession(db, "s1", { full: true });
		const res = await put({ set: { "pricing.overrides": { sonnet: { input: 1, output: 2 } } } });
		expect(res.status).toBe(200);
		await waitForRepriceJob();
		expect(stalePriceSessions(db)).toEqual([]);
		expect(db.prepare("SELECT cost_usd AS c FROM usage").get<{ c: number }>()?.c).toBeCloseTo(1);
		const c = await getConfig();
		expect(c.pricing.effectiveVersion).not.toBe(PRICE_TABLE_VERSION);
	});

	it("rejects an invalid override with 422 naming the entry", async () => {
		const res = await put({ set: { "pricing.overrides": { opus: { input: "cheap", output: 2 } } } });
		expect(res.status).toBe(422);
		const body = (await res.json()) as { error: { fields: { key: string }[] } };
		expect(body.error.fields[0].key).toBe("pricing.overrides.opus");
	});
});

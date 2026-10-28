// Phase 7 Task 8: GET /api/activity — params, shape and the leak assertion.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../../src/db/adapter";
import { createApp } from "../../../src/server/app";
import type { ActivityResponse } from "../../../src/server/types";
import { LEAK_FOLDER, LEAK_PROMPT, seedParitySession } from "../../helpers/parity-seed";
import { seedDb } from "../../helpers/seed";
import { type TmpHome, tmpHome } from "../../helpers/tmp-home";

let h: TmpHome;
let db: Db;
beforeEach(() => {
	h = tmpHome();
	db = seedDb();
	seedParitySession(db, "leaky", {
		startedAt: new Date(Date.now() - 3_600_000).toISOString(),
		cwd: `/home/u/${LEAK_FOLDER}`,
		prompt: LEAK_PROMPT,
		usage: [{ input: 10 }],
	});
});
afterEach(() => {
	db.close();
	h.cleanup();
});

const get = (path: string) =>
	createApp(db, { port: 4242, uiDir: "/x" }).request(path, { headers: { host: "localhost:4242" } });

describe("GET /api/activity", () => {
	it("returns the heatmap and the range's stats", async () => {
		const r = await get("/api/activity?range=7d");
		expect(r.status).toBe(200);
		const a = (await r.json()) as ActivityResponse;
		expect(a.days).toHaveLength(365);
		expect(a.sessions).toBe(1);
		expect(a.streak.current).toBe(1);
	});
	it("rejects a bad range", async () => {
		expect((await get("/api/activity?range=week")).status).toBe(400);
	});
	it("never carries prompt text or a path", async () => {
		const text = await (await get("/api/activity?range=all")).text();
		expect(text).not.toContain(LEAK_PROMPT);
		expect(text).not.toContain(LEAK_FOLDER);
	});
});

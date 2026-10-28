// Hook own-work budget (Phase 1 spec: p95 <= 50 ms): 100 events cycled from the Phase 0 hook fixtures, in-process,
// with a fake spawn and one open DB. Node startup is not part of this number (Phase 0 B3 measured it separately).
// Run with `npm run test:perf` (or PERF=1): each insert commits and syncs the WAL, so in the parallel unit suite
// other files' disk writes stalled commits past 60 ms and the budget failed for reasons outside the hook.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/adapter";
import { runHook } from "../../src/hook/run";
import { hookFixtures } from "../helpers/fixtures";
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

describe("hook performance", () => {
	it("keeps p95 of runHook at or under 50 ms over 100 fixture events", async () => {
		const fixtures = hookFixtures();
		const times: number[] = [];
		for (let i = 0; i < 100; i++) {
			const f = fixtures[i % fixtures.length];
			const start = performance.now();
			await runHook(f.raw, {}, db, { spawn: () => {} });
			times.push(performance.now() - start);
		}
		times.sort((a, b) => a - b);
		const p95 = times[Math.ceil(times.length * 0.95) - 1];
		expect(p95).toBeLessThanOrEqual(50);
		const rows = db.prepare("SELECT count(*) AS n FROM events").get<{ n: number }>();
		expect(rows?.n).toBe(100 - fixtures.filter((f) => f.name === "Stop").length * 5);
	});
});

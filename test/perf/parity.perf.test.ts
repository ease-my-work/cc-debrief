// Phase 7 budgets (spec exit criteria): getActivity(all) and getCosts(90d) p95 ≤ 200 ms. The spec names a 500-session
// fixture; this one has 2,000 sessions (40k usage rows, about the author's real 90 days of 36k), so it is stricter.
// The 10,000-session timings are logged for comparison, not asserted. Run with `npm run test:perf` (or PERF=1).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConfigSchema } from "../../src/config";
import type { Db } from "../../src/db/adapter";
import { openDb } from "../../src/db/adapter";
import { migrate } from "../../src/db/migrate";
import { getActivity } from "../../src/db/queries/activity";
import { getCosts } from "../../src/db/queries/costs";
import { seedLarge } from "../helpers/seed-large";
import { type TmpHome, tmpHome } from "../helpers/tmp-home";

const NOW = new Date("2026-10-02T12:00:00Z");
const RUNS = 20;
const cfg = ConfigSchema.parse({ budget: { monthlyUsd: 500 } });

let h: TmpHome;
let db: Db;
let large: Db;
beforeAll(() => {
	h = tmpHome();
	db = openDb(`${h.home}-2k.db`);
	migrate(db);
	seedLarge(db, NOW, { sessions: 2000 });
	large = openDb(`${h.home}-10k.db`);
	migrate(large);
	seedLarge(large, NOW);
}, 600_000);
afterAll(() => {
	db.close();
	large.close();
	h.cleanup();
});

function p95(fn: () => void): number {
	fn();
	const ms: number[] = [];
	for (let i = 0; i < RUNS; i++) {
		const t = performance.now();
		fn();
		ms.push(performance.now() - t);
	}
	ms.sort((a, b) => a - b);
	return ms[Math.ceil(RUNS * 0.95) - 1];
}

describe("Phase 7 query performance", () => {
	it("getActivity(all) p95 ≤ 200 ms on 2,000 sessions", () => {
		const ms = p95(() => getActivity(db, { range: "all", now: NOW }));
		const big = p95(() => getActivity(large, { range: "all", now: NOW }));
		console.log(`getActivity(all) p95 ${ms.toFixed(1)} ms (10,000 sessions: ${big.toFixed(1)} ms)`);
		expect(ms).toBeLessThanOrEqual(200);
	});

	it("getCosts(90d) p95 ≤ 200 ms on 2,000 sessions", () => {
		const ms = p95(() => getCosts(db, { range: "90d", now: NOW, cfg }));
		const big = p95(() => getCosts(large, { range: "90d", now: NOW, cfg }));
		console.log(`getCosts(90d) p95 ${ms.toFixed(1)} ms (10,000 sessions: ${big.toFixed(1)} ms)`);
		expect(ms).toBeLessThanOrEqual(200);
	});
});

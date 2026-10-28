// Phase 2 budgets (spec): GET /api/overview ≤ 200 ms p95 on 10,000 sessions / 1M transcript lines; the first page of
// the sessions list ≤ 100 ms; no query plan scans transcript_lines. Run with `npm run test:perf` (or PERF=1).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/adapter";
import { getOverview } from "../../src/db/queries/overview";
import { listSessions } from "../../src/db/queries/sessions";
import { seedDb } from "../helpers/seed";
import { LARGE, seedLarge } from "../helpers/seed-large";
import { type TmpHome, tmpHome } from "../helpers/tmp-home";

const NOW = new Date("2026-10-02T12:00:00Z");
const RUNS = 20;

let h: TmpHome;
let db: Db;
beforeAll(() => {
	h = tmpHome();
	db = seedDb();
	const t = performance.now();
	seedLarge(db, NOW);
	console.log(`seedLarge: ${((performance.now() - t) / 1000).toFixed(1)} s`);
}, 600_000);
afterAll(() => {
	db.close();
	h.cleanup();
});

function p95(fn: () => void): number {
	fn(); // warm the page cache and statement cache
	const ms: number[] = [];
	for (let i = 0; i < RUNS; i++) {
		const t = performance.now();
		fn();
		ms.push(performance.now() - t);
	}
	ms.sort((a, b) => a - b);
	return ms[Math.ceil(RUNS * 0.95) - 1];
}

/** Every EXPLAIN QUERY PLAN line SQLite produced while fn ran. */
function plans(fn: () => void): string[] {
	const prepare = db.prepare.bind(db);
	const out: string[] = [];
	db.prepare = (sql: string) => {
		const stmt = prepare(sql);
		const explain = (...p: unknown[]) => {
			if (/^\s*(SELECT|WITH)/i.test(sql))
				for (const r of prepare(`EXPLAIN QUERY PLAN ${sql}`).all<{ detail: string }>(...p)) out.push(r.detail);
		};
		return {
			run: stmt.run.bind(stmt),
			get: (...p: unknown[]) => {
				explain(...p);
				return stmt.get(...p);
			},
			all: (...p: unknown[]) => {
				explain(...p);
				return stmt.all(...p);
			},
		} as typeof stmt;
	};
	try {
		fn();
	} finally {
		db.prepare = prepare;
	}
	return out;
}

describe("dashboard query performance (10,000 sessions, 1M lines)", () => {
	it("has the seeded volume", () => {
		const n = (t: string) => db.prepare(`SELECT count(*) AS n FROM ${t}`).get<{ n: number }>()?.n;
		expect(n("sessions")).toBe(LARGE.sessions);
		expect(n("transcript_lines")).toBe(LARGE.sessions * LARGE.lines);
	});

	it.each(["7d", "30d"] as const)("getOverview(%s) p95 ≤ 200 ms", (range) => {
		const ms = p95(() => getOverview(db, { range, now: NOW }));
		console.log(`getOverview(${range}) p95 ${ms.toFixed(1)} ms`);
		expect(ms).toBeLessThanOrEqual(200);
	});

	it("listSessions first page ≤ 100 ms", () => {
		const ms = p95(() => listSessions(db, { range: "30d", limit: 50, now: NOW }));
		console.log(`listSessions p95 ${ms.toFixed(1)} ms`);
		expect(ms).toBeLessThanOrEqual(100);
	});

	it("never scans transcript_lines and uses indexes for the big tables", () => {
		const lines = [
			...plans(() => getOverview(db, { range: "30d", now: NOW })),
			...plans(() => listSessions(db, { range: "30d", limit: 50, now: NOW })),
		];
		expect(lines.some((l) => /transcript_lines/.test(l))).toBe(false);
		const scans = lines.filter((l) => /^SCAN (usage|tool_calls|file_changes|turns|inventory_usage)\b/.test(l));
		expect(scans).toEqual([]);
	});
});

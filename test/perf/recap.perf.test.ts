// Phase 6 budgets (spec "Performance"): GET /api/recap?range=week ≤ 200 ms and range=today ≤ 50 ms (p95) on the
// 10,000-session / 1M-line fixture. Run with `npm run test:perf` (or PERF=1).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "../../src/db/adapter";
import { createApp } from "../../src/server/app";
import type { RecapResponse } from "../../src/server/types";
import { seedDb } from "../helpers/seed";
import { seedLarge } from "../helpers/seed-large";
import { type TmpHome, tmpHome } from "../helpers/tmp-home";

const NOW = new Date("2026-10-02T12:00:00Z");
const RUNS = 20;
const HOST = { host: "127.0.0.1:4242" };

let h: TmpHome;
let db: Db;
beforeAll(() => {
	h = tmpHome();
	db = seedDb();
	seedLarge(db, NOW);
	// The tracker's own calls: about one per summarised session (ai_calls.session_id has no index).
	db.transaction(() => {
		const call = db.prepare("INSERT INTO ai_calls (feature, session_id, ts) VALUES ('summary', ?, ?)");
		for (let i = 0; i < 10_000; i++) call.run(`call-${i}`, NOW.toISOString());
	});
	vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
}, 600_000);
afterAll(() => {
	vi.useRealTimers();
	db.close();
	h.cleanup();
});

async function p95(fn: () => Promise<unknown>): Promise<number> {
	await fn(); // warm the page cache and statement cache
	const ms: number[] = [];
	for (let i = 0; i < RUNS; i++) {
		const t = performance.now();
		await fn();
		ms.push(performance.now() - t);
	}
	ms.sort((a, b) => a - b);
	return ms[Math.ceil(RUNS * 0.95) - 1];
}

describe("recap performance (10,000 sessions, 1M lines)", () => {
	const app = () => createApp(db, { port: 4242, uiDir: "/x" });
	const get = async (q: string) => {
		const r = await app().request(`/api/recap${q}`, { headers: HOST });
		expect(r.status).toBe(200);
		return (await r.json()) as RecapResponse;
	};

	it.each([
		["?range=week", 200],
		["?range=week&groupBy=day", 200],
		["", 50],
	])("GET /api/recap%s p95 ≤ %i ms", async (q, budget) => {
		const sessions = (await get(q)).recap.sessions;
		expect(sessions).toBeGreaterThan(0);
		const ms = await p95(() => get(q));
		console.log(`GET /api/recap${q} (${sessions} sessions) p95 ${ms.toFixed(1)} ms`);
		expect(ms).toBeLessThanOrEqual(budget);
	});
});

// Phase 4 budgets (spec, plan Task 12): GET /api/improvements (buildDigest) ≤ 200 ms p95 on the 10,000-session seed
// with ~2 findings per session plus digest-rule findings; runDigestRules ≤ 5 s on that seed; runTier1 for one 200-turn
// session ≤ 200 ms. Run with `npm run test:perf` (or PERF=1).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildDigest, runDigestRules } from "../../src/coach/digest";
import { runTier1 } from "../../src/coach/tier1";
import { loadConfig } from "../../src/config";
import type { Db } from "../../src/db/adapter";
import { encodePayload } from "../../src/ingest/line";
import { createApp } from "../../src/server/app";
import { seedDb } from "../helpers/seed";
import { LARGE, seedLarge } from "../helpers/seed-large";
import { type TmpHome, tmpHome } from "../helpers/tmp-home";

const NOW = new Date("2026-10-02T12:00:00Z");
const RUNS = 20;
const LONG = "ffffffff-0000-4000-8000-000000000200";

let h: TmpHome;
let db: Db;
let ids: string[];

/** Two Tier 1 findings per session, created when the session ran, spread over the rules and repos. */
function seedFindings(): void {
	const rules = ["retry_loop", "context_churn", "permission_friction", "long_session_no_compaction", "mcp_bypassed"];
	const ins = db.prepare(
		`INSERT INTO findings (session_id, rule, subject_key, repo_id, severity, message, evidence, cost_tokens, created_at)
		 SELECT session_id, ?, ?, repo_id, ?, ?, ?, ?, started_at FROM sessions WHERE session_id = ?`,
	);
	db.transaction(() => {
		ids.forEach((id, s) => {
			for (let k = 0; k < 2; k++) {
				const rule = rules[(s + k) % rules.length];
				ins.run(
					rule,
					`key-${k}`,
					(["low", "medium", "high"] as const)[(s + k) % 3],
					`${rule} in session ${s}`,
					JSON.stringify({ key: `key-${k}`, count: 3, turns: [1, 2], target: "session" }),
					1000 + ((s * 37 + k * 11) % 50_000),
					id,
				);
			}
		});
	});
}

/** A 200-turn session with 3 tool calls and one usage row per turn. */
function seedLongSession(): void {
	const start = NOW.getTime() - 6 * 3_600_000;
	const at = (ms: number) => new Date(start + ms).toISOString();
	db.transaction(() => {
		db.prepare(
			"INSERT INTO sessions (session_id, started_at, ended_at, repo_id, capture) VALUES (?, ?, ?, 'github.com/org/repo1', 'hooks')",
		).run(LONG, at(0), at(200 * 60_000));
		const turn = db.prepare(
			"INSERT INTO turns (session_id, seq, user_text, started_at, ended_at) VALUES (?, ?, ?, ?, ?)",
		);
		const usage = db.prepare(
			"INSERT INTO usage (session_id, turn_id, model, input_tokens, output_tokens, cache_read_tokens, ts) VALUES (?, ?, 'claude-sonnet-4-5', 2000, 400, 30000, ?)",
		);
		const call = db.prepare(
			`INSERT INTO tool_calls (session_id, turn_id, tool_name, input, response, started_at, ended_at, ok, exit_code)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		const response = encodePayload({ bytes: 6000, isError: false, excerpt: "x".repeat(200) });
		for (let t = 1; t <= 200; t++) {
			const base = (t - 1) * 60_000;
			const id = Number(
				turn.run(LONG, t, `please run the tests and fix step ${t}`, at(base), at(base + 50_000)).lastInsertRowid,
			);
			usage.run(LONG, id, at(base + 40_000));
			call.run(
				LONG,
				id,
				"Read",
				encodePayload({ file_path: `/w/repo1/src/f${t % 7}.ts` }),
				response,
				at(base + 1000),
				at(base + 2000),
				1,
				null,
			);
			call.run(
				LONG,
				id,
				"Bash",
				encodePayload({ command: "npm test" }),
				response,
				at(base + 3000),
				at(base + 9000),
				t % 4 === 0 ? 1 : 0,
				t % 4 === 0 ? null : 1,
			);
			call.run(
				LONG,
				id,
				"Edit",
				encodePayload({ file_path: `/w/repo1/src/f${t % 7}.ts` }),
				response,
				at(base + 10_000),
				at(base + 11_000),
				1,
				null,
			);
		}
		db.prepare(
			"INSERT INTO inventory_usage (inventory_id, session_id, loaded, invoked) SELECT id, ?, 1, 0 FROM inventory",
		).run(LONG);
	});
}

beforeAll(() => {
	h = tmpHome();
	db = seedDb();
	let t = performance.now();
	ids = seedLarge(db, NOW);
	seedFindings();
	seedLongSession();
	console.log(`seed: ${((performance.now() - t) / 1000).toFixed(1)} s`);
	t = performance.now();
	runDigestRules(db, NOW);
	console.log(`first runDigestRules: ${(performance.now() - t).toFixed(0)} ms`);
}, 900_000);
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

describe("coaching performance (10,000 sessions)", () => {
	it("has the seeded volume", () => {
		const n = (sql: string) => db.prepare(sql).get<{ n: number }>()?.n ?? 0;
		expect(n("SELECT count(*) AS n FROM sessions")).toBe(LARGE.sessions + 1);
		expect(n("SELECT count(*) AS n FROM findings WHERE session_id IS NOT NULL")).toBe(LARGE.sessions * 2);
		// seedLarge fails Read, Glob and Bash once each per session: a failure hotspot per tool and repo this week.
		expect(n("SELECT count(*) AS n FROM findings WHERE rule = 'tool_failure_hotspot'")).toBe(60);
	});

	it.each(["7d", "30d"] as const)("buildDigest(%s) p95 ≤ 200 ms", (range) => {
		const cfg = loadConfig();
		const ms = p95(() => buildDigest(db, { range, now: NOW, cfg }));
		console.log(`buildDigest(${range}) p95 ${ms.toFixed(1)} ms`);
		expect(buildDigest(db, { range, now: NOW, cfg }).items.length).toBeGreaterThan(0);
		expect(ms).toBeLessThanOrEqual(200);
	});

	it("GET /api/improvements p95 ≤ 200 ms", async () => {
		const app = createApp(db, { port: 4242, uiDir: "/x" });
		const request = () => app.request("/api/improvements?range=7d", { headers: { host: "127.0.0.1:4242" } });
		await request();
		const ms: number[] = [];
		for (let i = 0; i < RUNS; i++) {
			const t = performance.now();
			const r = await request();
			await r.json();
			ms.push(performance.now() - t);
		}
		ms.sort((a, b) => a - b);
		const p = ms[Math.ceil(RUNS * 0.95) - 1];
		console.log(`GET /api/improvements p95 ${p.toFixed(1)} ms`);
		expect(p).toBeLessThanOrEqual(200);
	});

	it("runDigestRules ≤ 5 s", () => {
		const t = performance.now();
		const written = runDigestRules(db, NOW);
		const ms = performance.now() - t;
		console.log(`runDigestRules ${ms.toFixed(0)} ms, ${written} findings`);
		expect(ms).toBeLessThanOrEqual(5000);
	});

	it("runTier1 for one 200-turn session p95 ≤ 200 ms", () => {
		const ms = p95(() => runTier1(db, LONG, { now: NOW }));
		const rules = db
			.prepare("SELECT DISTINCT rule FROM findings WHERE session_id = ? ORDER BY rule")
			.all<{ rule: string }>(LONG)
			.map((r) => r.rule);
		console.log(`runTier1(200 turns) p95 ${ms.toFixed(1)} ms; rules ${rules.join(", ")}`);
		expect(rules).toEqual(expect.arrayContaining(["context_churn", "retry_loop"]));
		expect(ms).toBeLessThanOrEqual(200);
	});
});

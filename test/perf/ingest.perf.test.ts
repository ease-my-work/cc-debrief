// Phase 1 performance budgets (spec): run with `npm run test:perf` (or PERF=1). Synthetic transcripts from
// test/helpers/gen-transcript.ts; one DB per test in a temp home.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setConfigValue } from "../../src/config";
import type { Db } from "../../src/db/adapter";
import { ingestPending, ingestSession } from "../../src/ingest/ingest";
import { appendGenLines, genSessionId, writeGenTranscript } from "../helpers/gen-transcript";
import { seedDb } from "../helpers/seed";
import { type TmpHome, tmpHome } from "../helpers/tmp-home";

let h: TmpHome;
let db: Db;
beforeEach(() => {
	h = tmpHome();
	setConfigValue("retention.days", "0"); // generated timestamps are fixed; never skip them
	db = seedDb();
});
afterEach(() => {
	db.close();
	h.cleanup();
});

const n = (sql: string, ...p: unknown[]) => (db.prepare(sql).get(...p) as { n: number }).n;
const timed = <T>(fn: () => T): { ms: number; value: T } => {
	const t = performance.now();
	const value = fn();
	return { ms: performance.now() - t, value };
};

describe("ingest performance", () => {
	it("backfills 500 sessions × 2,000 lines within 150 s and 200 MB of RSS growth", () => {
		for (let i = 0; i < 500; i++)
			writeGenTranscript(h.claude, `p${i % 20}`, genSessionId(i), { lines: 2000, seed: i + 1 });
		global.gc?.();
		const rss = process.memoryUsage().rss;
		const { ms, value } = timed(() => ingestPending(db));
		const growth = (process.memoryUsage().rss - rss) / 1024 / 1024;
		console.log(`backfill: ${(ms / 1000).toFixed(1)} s, RSS +${growth.toFixed(0)} MB, ${value.lines} lines`);
		expect(value).toMatchObject({ files: 500, lines: 1_000_000, parseErrors: 0 });
		expect(value.sessions).toHaveLength(500);
		expect(n("SELECT count(*) AS n FROM sessions")).toBe(500);
		expect(n("SELECT count(*) AS n FROM tool_calls")).toBe(500 * 50);
		expect(n("SELECT count(*) AS n FROM transcript_lines WHERE session_id = ?", genSessionId(7))).toBe(2000);
		expect(ms).toBeLessThan(150_000); // spec: revised from 60 s on 2026-09-30
		expect(growth).toBeLessThan(200);
	}, 600_000);

	it.each([
		[2_000, 50],
		[20_000, 300],
	])(
		"appends 40 lines to an ingested %i-line session within 300 ms",
		(lines, toolCalls) => {
			const id = genSessionId(1);
			const path = writeGenTranscript(h.claude, "p", id, { lines, toolCalls, seed: 3 });
			ingestSession(db, id);
			const runs: number[] = [];
			for (let k = 0; k < 5; k++) {
				appendGenLines(path, id, { lines: 40, toolCalls: 2, start: lines + k * 40, seed: 10 + k });
				runs.push(timed(() => ingestSession(db, id)).ms);
			}
			const median = runs.sort((a, b) => a - b)[2];
			console.log(
				`append 40 to ${lines}: median ${median.toFixed(0)} ms (${runs.map((r) => r.toFixed(0)).join(", ")})`,
			);
			expect(n("SELECT count(*) AS n FROM transcript_lines")).toBe(lines + 200);
			expect(n("SELECT count(*) AS n FROM tool_calls")).toBe(toolCalls + 10);
			expect(median).toBeLessThan(300);
		},
		120_000,
	);

	it("ingests one fresh 2,000-line session within 1 s", () => {
		const id = genSessionId(2);
		writeGenTranscript(h.claude, "p", id, { lines: 2000, seed: 5 });
		const { ms, value } = timed(() => ingestSession(db, id));
		console.log(`fresh 2,000-line session: ${ms.toFixed(0)} ms`);
		expect(value.lines).toBe(2000);
		expect(ms).toBeLessThan(1000);
	}, 60_000);
});

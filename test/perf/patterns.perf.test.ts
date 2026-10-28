// Phase 5b budgets (plan Task 11): detectPatterns for a repo with 500 sessions in 30 days ≤ 2 s; crossRepoPatterns
// over 20 repos ≤ 3 s. Each session has a 12-call skeleton (a few shared shapes, so components form) and a first prompt.
// Run with `npm run test:perf` (or PERF=1).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/adapter";
import { crossRepoPatterns } from "../../src/patterns/crossrepo";
import { detectPatterns } from "../../src/patterns/detect";
import { daysAgo, PATTERN_NOW, seedPatternSession } from "../helpers/pattern-seed";
import { seedDb } from "../helpers/seed";
import { type TmpHome, tmpHome } from "../helpers/tmp-home";

let h: TmpHome;
let db: Db;

const SHAPES = 25;
/** Skeleton shape k: 12 calls over files and commands that differ per shape. */
const calls = (k: number): [string, Record<string, unknown>][] =>
	Array.from({ length: 12 }, (_, i) =>
		i % 3 === 0
			? ["Bash", { command: `npm run task${(k + i) % SHAPES}` }]
			: i % 3 === 1
				? ["Read", { file_path: `/r/src/mod${k}/f${i}.ts` }]
				: ["Edit", { file_path: `/r/src/mod${k}/f${i}.ts` }],
	);

function seedRepo(repo: string, n: number, offset: number): void {
	db.transaction(() => {
		for (let i = 0; i < n; i++) {
			const k = (i + offset) % SHAPES;
			seedPatternSession(db, `${repo}-${i}`, {
				repo,
				calls: calls(k),
				label: i % 4 === 0 ? `task family ${k}` : undefined,
				prompts: [`please work on module ${k} item ${i} with care`, "follow up"],
				startedAt: daysAgo(((i * 7) % 290) / 10),
				tokens: 20_000 + (i % 13) * 1000,
			});
		}
	});
}

beforeAll(() => {
	h = tmpHome();
	db = seedDb();
	seedRepo("big", 500, 0);
	for (let r = 0; r < 19; r++) seedRepo(`repo${r}`, 40, r);
}, 300_000);

afterAll(() => {
	db.close();
	h.cleanup();
});

describe("pattern detection performance", () => {
	it("detectPatterns over a 500-session repo ≤ 2 s", () => {
		const t0 = performance.now();
		const r = detectPatterns(db, "big", PATTERN_NOW);
		const ms = performance.now() - t0;
		expect(r.created).toBeGreaterThan(0);
		expect(ms).toBeLessThanOrEqual(2000);
	});

	it("crossRepoPatterns over 20 repos ≤ 3 s", () => {
		const t0 = performance.now();
		crossRepoPatterns(db, PATTERN_NOW);
		const ms = performance.now() - t0;
		expect(ms).toBeLessThanOrEqual(3000);
	});
});

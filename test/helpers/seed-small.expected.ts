// Hand-computed answers for seed-small.ts at SMALL_NOW (see the comments for the arithmetic).
import type { Overview } from "../../src/server/types";
import { OPUS, SONNET } from "./seed-small";

// 7d = S1..S5. Session totals: S1 counted 200/100/200/1500 = 2000, $0.15; S2 reported 300/200/100/2400 = 3000, $1.50;
// S3 counted 50/50/0/0 = 100, unknown model; S4 counted 10/10/0/80 = 100, $0.01; S5 no usage = 0.
// Cache served = cacheRead / (input + cacheWrite + cacheRead) = 3980 / (560 + 300 + 3980) = 82.2% → 82.
export const OVERVIEW_7D_TILES: Overview["tiles"] = {
	sessions: {
		total: 5,
		bySurface: { cli: 3, vscode: 1, desktop: 1, unknown: 0 },
		byRepo: [
			{ repoId: "github.com/me/app", name: "app", sessions: 3 },
			{ repoId: "github.com/me/api", name: "api", sessions: 1 },
			{ repoId: null, name: "no repo", sessions: 1 },
		],
	},
	tokens: { total: 5200, cacheServedPct: 82 },
	cost: {
		usd: 1.66,
		byModel: [
			{ model: OPUS, label: "Opus", usd: 1.5 },
			{ model: SONNET, label: "Sonnet", usd: 0.16 },
		],
		unknownModelTokens: 100,
	},
	// S1 src/a.ts +10 −2, src/b.ts +5, README.md +3 −1; S2 web/login.tsx +40 → 4 files in 2 repos.
	lines: { added: 58, removed: 3, files: 4, repos: 2 },
};

// Local days 26 Sep … 2 Oct. input = input + cache writes. S2's unattributed (reported − counted: input 100,
// output 100, cacheRead 800) lands on its last-activity day, 30 Sep, so the columns sum to the tiles.
export const TOKENS_PER_DAY_7D: Overview["tokensPerDay"] = [
	{ date: "2026-09-26", input: 0, cacheRead: 0, output: 0 },
	{ date: "2026-09-27", input: 0, cacheRead: 0, output: 0 },
	{ date: "2026-09-28", input: 0, cacheRead: 0, output: 0 },
	{ date: "2026-09-29", input: 50, cacheRead: 0, output: 50 },
	{ date: "2026-09-30", input: 400, cacheRead: 2400, output: 200 },
	{ date: "2026-10-01", input: 400, cacheRead: 1500, output: 100 },
	{ date: "2026-10-02", input: 10, cacheRead: 80, output: 10 },
];

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../../src/db/adapter";
import { listPatternRows } from "../../../src/db/queries/patterns";
import { crossRepoPatterns } from "../../../src/patterns/crossrepo";
import { detectPatterns } from "../../../src/patterns/detect";
import { daysAgo, ensureRepo, PATTERN_NOW, seedPatternSession, TRIVY_CALLS } from "../../helpers/pattern-seed";
import { seedDb } from "../../helpers/seed";
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

const NOW = PATTERN_NOW;
const kinds = (repo: string | null = "ra") => listPatternRows(db, { repo }).map((p) => [p.kind, p.label]);
const findingMessages = () =>
	db
		.prepare("SELECT rule, message FROM findings WHERE session_id IS NULL ORDER BY id")
		.all<{ rule: string; message: string }>();

describe("classification", () => {
	it("a component of 3 bugfix sessions editing services/cache.py is a test gap", () => {
		for (const [i, id] of ["s1", "s2", "s3"].entries())
			seedPatternSession(db, id, {
				label: "fix cache invalidation",
				sessionType: "bugfix",
				edits: ["services/cache.py", `other${i}.py`],
				prompts: [`bug ${i}`],
			});
		detectPatterns(db, "ra", NOW);
		expect(kinds()).toEqual([["test_gap", "services/cache.py"]]);
		const [p] = listPatternRows(db, { repo: "ra" });
		expect(p.meta.testGapPath).toBe("services/cache.py");
		expect(findingMessages()).toEqual([
			{
				rule: "test_gap",
				message: "`services/cache.py` fixed in 3 separate bugfix sessions in `ra` — no test covers it",
			},
		]);
	});

	it("3 sessions repeating one correction in later prompts are a CLAUDE.md rule, labelled with the central one", () => {
		const fixes = ["use httpx not requests", "don't use requests, use httpx", "stop using requests; httpx instead"];
		for (const [i, id] of ["s1", "s2", "s3"].entries())
			seedPatternSession(db, id, { prompts: [`unrelated task number ${i} alpha${i}`, fixes[i]] });
		detectPatterns(db, "ra", NOW);
		expect(kinds()).toEqual([["claude_md_rule", "use httpx not requests"]]);
		const [p] = listPatternRows(db, { repo: "ra" });
		expect(p.meta.correctionCount).toBe(3);
		expect(p.meta.corrections).toHaveLength(3);
		expect(findingMessages()[0].message).toBe('Corrected by you in 3 sessions in `ra`: "use httpx not requests"');
	});

	it("a correction in the first prompt does not count", () => {
		for (const id of ["s1", "s2", "s3"]) seedPatternSession(db, id, { prompts: ["use httpx not requests"] });
		detectPatterns(db, "ra", NOW);
		expect(kinds()).toEqual([]);
	});

	it("the same two files read in the first five calls of 4 of 6 sessions are a pointer", () => {
		ensureRepo(db, "ra", "/repos/ra");
		const reads: [string, Record<string, unknown>][] = [
			["Read", { file_path: "/repos/ra/docs/arch.md" }],
			["Read", { file_path: "/repos/ra/src/config.ts" }],
		];
		for (let i = 0; i < 6; i++) {
			seedPatternSession(db, `s${i}`, {
				prompts: [`task ${i} word${i}`],
				calls: i < 4 ? [...reads, ["Grep", { pattern: `x${i}` }]] : [["Grep", { pattern: "y" }]],
			});
		}
		detectPatterns(db, "ra", NOW);
		const [p] = listPatternRows(db, { repo: "ra" });
		expect(p).toMatchObject({ kind: "claude_md_pointer", sessionIds: ["s0", "s1", "s2", "s3"] });
		expect(p.meta.readFiles).toEqual(["docs/arch.md", "src/config.ts"]);
		expect(p.label).toBe("Read at session start: docs/arch.md, src/config.ts");
	});

	it("a real repeated task that also reads the start-up files stays a repo skill next to the pointer", () => {
		const start: [string, Record<string, unknown>][] = [
			["Read", { file_path: "/repos/ra/docs/arch.md" }],
			["Read", { file_path: "/repos/ra/src/config.ts" }],
		];
		for (let i = 0; i < 4; i++)
			seedPatternSession(db, `s${i}`, { prompts: [`task ${i} word${i}`], calls: [...start, ...TRIVY_CALLS] });
		detectPatterns(db, "ra", NOW);
		expect(
			listPatternRows(db, { repo: "ra" })
				.map((p) => p.kind)
				.sort(),
		).toEqual(["claude_md_pointer", "repo_skill"]);
	});

	it("3 of 7 sessions reading the files is under 50%: no pointer", () => {
		for (let i = 0; i < 7; i++) {
			seedPatternSession(db, `s${i}`, {
				prompts: [`task ${i} word${i}`],
				calls:
					i < 3
						? [
								["Read", { file_path: "/repos/ra/docs/arch.md" }],
								["Read", { file_path: "/repos/ra/src/config.ts" }],
							]
						: [],
			});
		}
		detectPatterns(db, "ra", NOW);
		expect(kinds()).toEqual([]);
	});

	it("a component matching none of rules 1-3 is a repo skill", () => {
		for (const id of ["s1", "s2", "s3"])
			seedPatternSession(db, id, { label: "fix trivy findings", calls: TRIVY_CALLS });
		detectPatterns(db, "ra", NOW);
		expect(kinds()).toEqual([["repo_skill", "fix trivy findings"]]);
	});
});

describe("crossRepoPatterns", () => {
	it("the same label in repo A (2 sessions) and repo B (2 sessions) is a user skill with repo_id NULL", () => {
		for (const id of ["a1", "a2"]) seedPatternSession(db, id, { repo: "ra", label: "bump node version" });
		for (const id of ["b1", "b2"]) seedPatternSession(db, id, { repo: "rb", label: "bumped node versions" });
		detectPatterns(db, "ra", NOW);
		detectPatterns(db, "rb", NOW);
		expect(listPatternRows(db)).toEqual([]); // two sessions per repo: no repo candidate
		expect(crossRepoPatterns(db, NOW)).toEqual({ created: 1, updated: 0 });
		const [p] = listPatternRows(db, { repo: null });
		expect(p).toMatchObject({ kind: "user_skill", repoId: null, sessionIds: ["a1", "a2", "b1", "b2"] });
		expect(findingMessages()).toEqual([
			{ rule: "repeat_pattern", message: "Repeated work: bumped node versions — 4 sessions in 30 days" },
		]);
	});

	it("only 2 sessions across 2 repos: none", () => {
		seedPatternSession(db, "a1", { repo: "ra", label: "bump node version", tokens: 80_000 });
		seedPatternSession(db, "b1", { repo: "rb", label: "bump node version", tokens: 80_000 });
		crossRepoPatterns(db, NOW);
		expect(listPatternRows(db)).toEqual([]);
	});

	it("3 sessions in one repo only are not a user skill", () => {
		for (const id of ["a1", "a2", "a3"]) seedPatternSession(db, id, { repo: "ra", label: "bump node version" });
		crossRepoPatterns(db, NOW);
		expect(listPatternRows(db, { repo: null })).toEqual([]);
	});

	it("a session without a repo joins by label, not by fingerprint", () => {
		seedPatternSession(db, "a1", { repo: "ra", calls: TRIVY_CALLS, startedAt: daysAgo(3) });
		seedPatternSession(db, "b1", { repo: "rb", calls: TRIVY_CALLS, startedAt: daysAgo(2) });
		seedPatternSession(db, "n1", { repo: null, calls: TRIVY_CALLS, startedAt: daysAgo(1) });
		crossRepoPatterns(db, NOW);
		expect(listPatternRows(db)).toEqual([]); // n1's fingerprint does not link it: 2 sessions
		seedPatternSession(db, "n2", { repo: null, calls: TRIVY_CALLS, label: "fix trivy" });
		seedPatternSession(db, "a2", { repo: "ra", calls: TRIVY_CALLS, label: "fix trivy" });
		seedPatternSession(db, "b2", { repo: "rb", label: "fix trivy" });
		crossRepoPatterns(db, NOW);
		expect(listPatternRows(db, { repo: null })[0]?.sessionIds).toEqual(expect.arrayContaining(["n2", "a2", "b2"]));
	});
});

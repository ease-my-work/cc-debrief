import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../../src/db/adapter";
import { getPattern, listPatternRows, setPatternStatus } from "../../../src/db/queries/patterns";
import { detectPatterns } from "../../../src/patterns/detect";
import { daysAgo, PATTERN_NOW, seedPatternSession, TRIVY_CALLS } from "../../helpers/pattern-seed";
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
const detect = (now = NOW) => detectPatterns(db, "ra", now);
const patterns = () => listPatternRows(db, { repo: "ra" });
const findings = () =>
	db
		.prepare("SELECT rule, subject_key, cost_tokens, repo_id FROM findings WHERE session_id IS NULL ORDER BY id")
		.all<{ rule: string; subject_key: string; cost_tokens: number; repo_id: string }>();
/** Distinct prompts per session, so prompt similarity alone never links them. */
const PROMPTS = [
	"alpha bravo charlie",
	"delta echo foxtrot",
	"golf hotel india",
	"juliet kilo lima",
	"mike november oscar",
];

describe("detectPatterns: clustering", () => {
	it("3 sessions with the same task label over the floor: one candidate and one repeat_pattern finding", () => {
		for (const [i, id] of ["s1", "s2", "s3"].entries())
			seedPatternSession(db, id, { label: "fix trivy findings", startedAt: daysAgo(5 - i), prompts: [PROMPTS[i]] });
		expect(detect()).toEqual({ created: 1, updated: 0 });
		const [p] = patterns();
		expect(p).toMatchObject({
			kind: "repo_skill",
			label: "fix trivy findings",
			labelNorm: "fix trivy find",
			status: "candidate",
			sessionIds: ["s1", "s2", "s3"],
			tokensTotal: 90_000,
		});
		expect(findings()).toEqual([
			{ rule: "repeat_pattern", subject_key: `pattern:${p.id}`, cost_tokens: 90_000, repo_id: "ra" },
		]);
	});

	it("near-duplicate labels merge into one candidate", () => {
		seedPatternSession(db, "s1", { label: "fix trivy findings", prompts: [PROMPTS[0]] });
		seedPatternSession(db, "s2", { label: "fixed trivy finding", prompts: [PROMPTS[1]] });
		seedPatternSession(db, "s3", { label: "Fix Trivy findings", prompts: [PROMPTS[2]] });
		detect();
		expect(patterns()).toHaveLength(1);
		expect(patterns()[0].sessionIds).toHaveLength(3);
	});

	it("3 unlabelled sessions with skeleton Jaccard ≥ 0.6: a candidate labelled with the newest fingerprint", () => {
		for (const [i, id] of ["s1", "s2", "s3"].entries())
			seedPatternSession(db, id, { calls: TRIVY_CALLS, startedAt: daysAgo(5 - i), prompts: [PROMPTS[i]] });
		detect();
		const [p] = patterns();
		expect(p.label).toBe("Bash:trivy → Read:Dockerfile → Edit:Dockerfile → Bash:docker build → Bash:trivy");
		expect(p.fingerprint).toBe(p.label);
	});

	it("3 sessions linked only by prompt similarity: none", () => {
		for (const id of ["s1", "s2", "s3"])
			seedPatternSession(db, id, { prompts: ["fix the trivy findings in the dockerfile base image"] });
		detect();
		expect(patterns()).toEqual([]);
	});

	it("below the cost floor, or only 2 sessions: none", () => {
		for (const id of ["s1", "s2", "s3"]) seedPatternSession(db, id, { label: "fix trivy findings", tokens: 10_000 });
		detect();
		expect(patterns()).toEqual([]);
		seedPatternSession(db, "b1", { label: "add endpoint", tokens: 100_000 });
		seedPatternSession(db, "b2", { label: "add endpoint", tokens: 100_000 });
		detect();
		expect(patterns()).toEqual([]);
	});

	it("a rerun with no new sessions changes nothing", () => {
		for (const id of ["s1", "s2", "s3"]) seedPatternSession(db, id, { label: "fix trivy findings" });
		detect();
		const before = db.prepare("SELECT * FROM patterns").all();
		expect(detect()).toEqual({ created: 0, updated: 0 });
		expect(db.prepare("SELECT * FROM patterns").all()).toEqual(before);
	});

	it("a drafted row grows with a new matching session and stays drafted", () => {
		for (const id of ["s1", "s2", "s3"]) seedPatternSession(db, id, { label: "fix trivy findings" });
		detect();
		const id = patterns()[0].id;
		setPatternStatus(db, id, "drafted", { draftPath: "/d" });
		seedPatternSession(db, "s4", { label: "fix trivy findings" });
		detect();
		expect(getPattern(db, id)).toMatchObject({ status: "drafted", sessionIds: ["s1", "s2", "s3", "s4"] });
	});

	it("a dismissed row stays dismissed for 30 days, then returns to candidate if it still qualifies", () => {
		for (const id of ["s1", "s2", "s3"])
			seedPatternSession(db, id, { label: "fix trivy findings", startedAt: daysAgo(1) });
		detect();
		const id = patterns()[0].id;
		setPatternStatus(db, id, "dismissed", { now: new Date(NOW.getTime() - 10 * 86_400_000) });
		detect();
		expect(getPattern(db, id)?.status).toBe("dismissed");
		expect(findings()).toEqual([]); // no finding while dismissed
		setPatternStatus(db, id, "dismissed", { now: new Date(NOW.getTime() - 31 * 86_400_000) });
		detect();
		expect(getPattern(db, id)?.status).toBe("candidate");
		expect(findings()).toHaveLength(1);
	});

	it("a session ageing out leaves 2: the candidate and its finding go; an installed row stays", () => {
		seedPatternSession(db, "old", { label: "fix trivy findings", startedAt: daysAgo(29) });
		seedPatternSession(db, "s2", { label: "fix trivy findings", startedAt: daysAgo(5) });
		seedPatternSession(db, "s3", { label: "fix trivy findings", startedAt: daysAgo(4) });
		for (const id of ["i1", "i2", "i3"])
			seedPatternSession(db, id, { label: "add alembic column", startedAt: daysAgo(28) });
		detect();
		expect(patterns()).toHaveLength(2);
		const installed = patterns().find((p) => p.label === "add alembic column")?.id as number;
		setPatternStatus(db, installed, "installed");
		detect(new Date(NOW.getTime() + 2 * 86_400_000));
		expect(patterns().map((p) => [p.label, p.status])).toEqual([["add alembic column", "installed"]]);
		expect(findings()).toEqual([]);
	});

	it("excludes the tracker's own call sessions", () => {
		for (const id of ["s1", "s2", "s3"]) seedPatternSession(db, id, { label: "fix trivy findings" });
		db.prepare("INSERT INTO self_usage (feature, session_id, ts) VALUES ('review', 's3', ?)").run(daysAgo(1));
		detect();
		expect(patterns()).toEqual([]);
	});

	it("only the 500 newest sessions are considered", () => {
		// 3 old matching sessions behind 500 newer, unrelated ones
		for (const id of ["o1", "o2", "o3"])
			seedPatternSession(db, id, { label: "fix trivy findings", startedAt: daysAgo(20) });
		// One transaction: 500 sessions of autocommit inserts took 38 s on the Windows CI runner.
		db.transaction(() => {
			for (let i = 0; i < 500; i++) seedPatternSession(db, `n${i}`, { startedAt: daysAgo(1), tokens: 1 });
		});
		detect();
		expect(patterns()).toEqual([]);
	});

	it("another repo's sessions and pattern findings are untouched", () => {
		for (const id of ["s1", "s2", "s3"]) seedPatternSession(db, id, { label: "fix trivy findings" });
		for (const id of ["b1", "b2", "b3"]) seedPatternSession(db, id, { repo: "rb", label: "fix trivy findings" });
		detectPatterns(db, "rb", NOW);
		detect();
		expect(
			findings()
				.map((f) => f.repo_id)
				.sort(),
		).toEqual(["ra", "rb"]);
		expect(
			listPatternRows(db)
				.map((p) => p.repoId)
				.sort(),
		).toEqual(["ra", "rb"]);
	});

	it("sessions without a repo are skipped", () => {
		expect(detectPatterns(db, null, NOW)).toEqual({ created: 0, updated: 0 });
	});
});

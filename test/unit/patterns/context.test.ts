import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { estimateCost } from "../../../src/collector/prices";
import { priceableModel } from "../../../src/collector/summarize";
import { type Config, ConfigSchema } from "../../../src/config";
import type { Db } from "../../../src/db/adapter";
import { setPatternStatus, upsertPattern } from "../../../src/db/queries/patterns";
import { assembleDraftContext, DRAFT_CONTEXT_MAX, estimateContextChars } from "../../../src/patterns/context";
import { DRAFT_SCHEMA, DraftResultSchema, estimateDraftCost } from "../../../src/patterns/draft";
import type { KeptLines } from "../../../src/patterns/kept-lines";
import { daysAgo, seedPatternSession, TRIVY_CALLS } from "../../helpers/pattern-seed";
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

const cfg = (ai: Partial<Config["ai"]> = {}): Config => {
	const c = ConfigSchema.parse({});
	return { ...c, ai: { ...c.ai, ...ai } };
};

function pattern(ids: string[], over: { kind?: "repo_skill" | "claude_md_rule"; corrections?: string[] } = {}): number {
	return upsertPattern(db, {
		repoId: "ra",
		label: "fix trivy findings",
		labelNorm: "fix trivy find",
		kind: over.kind ?? "repo_skill",
		sessionIds: ids,
		tokensTotal: 90_000,
		fingerprint: null,
		firstSeen: daysAgo(5),
		lastSeen: daysAgo(1),
		meta: over.corrections ? { corrections: over.corrections } : {},
	}).id;
}

const keptFor =
	(byId: Record<string, KeptLines>) =>
	(id: string): KeptLines =>
		byId[id] ?? { lines: [], verified: true };

describe("assembleDraftContext", () => {
	it("holds each session's first prompt, summary, skeleton and kept lines, newest first, no discarded line", () => {
		seedPatternSession(db, "old", { calls: TRIVY_CALLS, prompts: ["fix trivy in api"], startedAt: daysAgo(5) });
		seedPatternSession(db, "new", { calls: TRIVY_CALLS, prompts: ["fix trivy in web"], startedAt: daysAgo(1) });
		db.prepare(
			"UPDATE sessions SET summary = 'Bumped the base image.', type_source = 'ai' WHERE session_id = 'new'",
		).run();
		const id = pattern(["old", "new"]);
		const ctx = assembleDraftContext(
			db,
			id,
			"create",
			keptFor({ new: { lines: [{ path: "Dockerfile", text: "FROM node:22.11-alpine" }], verified: true } }),
		);
		expect(ctx.sessions).toEqual(["new", "old"]);
		expect(ctx.unverified).toBe(false);
		expect(ctx.prompt).not.toContain("[cc-debrief:"); // runClaude adds the sentinel
		expect(ctx.prompt).toContain('a task the developer repeated: "fix trivy findings" (2 sessions)');
		expect(ctx.prompt.indexOf("fix trivy in web")).toBeLessThan(ctx.prompt.indexOf("fix trivy in api"));
		expect(ctx.prompt).toContain("Summary: Bumped the base image.");
		expect(ctx.prompt).toContain("Tools: Bash:trivy → Read:Dockerfile → Edit:Dockerfile");
		expect(ctx.prompt).toContain("Kept lines (committed):\n- Dockerfile\n    FROM node:22.11-alpine");
		expect(ctx.chars).toBe(ctx.prompt.length);
	});

	it("labels unverified kept lines", () => {
		seedPatternSession(db, "s1");
		const id = pattern(["s1"]);
		const ctx = assembleDraftContext(
			db,
			id,
			"create",
			keptFor({ s1: { lines: [{ path: "a.ts", text: "const x = 1;" }], verified: false } }),
		);
		expect(ctx.unverified).toBe(true);
		expect(ctx.prompt).toContain("Kept lines (unverified");
	});

	it("caps at 60,000 characters by dropping the oldest sessions", () => {
		const ids: string[] = [];
		for (let i = 0; i < 6; i++) ids.push(seedPatternSession(db, `s${i}`, { startedAt: daysAgo(6 - i) }));
		const id = pattern(ids);
		const big = (sid: string): KeptLines => ({
			lines: Array.from({ length: 40 }, (_, j) => ({
				path: `f${sid}.ts`,
				text: `${sid} line ${j} ${"x".repeat(400)}`,
			})),
			verified: true,
		});
		const ctx = assembleDraftContext(db, id, "create", big);
		expect(ctx.chars).toBeLessThanOrEqual(DRAFT_CONTEXT_MAX);
		expect(ctx.sessions[0]).toBe("s5"); // newest kept
		expect(ctx.sessions).not.toContain("s0"); // oldest dropped
	});

	it("widen lists only the first prompts of sessions that did not invoke the skill", () => {
		seedPatternSession(db, "used", {
			prompts: ["bump trivy findings please"],
			calls: [["Skill", { skill: "trivy-fix" }]],
		});
		db.prepare("UPDATE tool_calls SET skill_name = 'trivy-fix' WHERE session_id = 'used'").run();
		seedPatternSession(db, "missed", { prompts: ["scanner says the image is vulnerable"] });
		db.prepare(
			"INSERT INTO inventory (id, scope, repo_id, kind, name, path, description, first_seen, last_seen) VALUES (9, 'repo', 'ra', 'skill', 'trivy-fix', '/r', 'Fix trivy findings', 't', 't')",
		).run();
		const id = pattern(["used", "missed"]);
		setPatternStatus(db, id, "installed", { inventoryId: 9 });
		const ctx = assembleDraftContext(db, id, "widen", keptFor({}));
		expect(ctx.sessions).toEqual(["missed"]);
		expect(ctx.prompt).toContain("- scanner says the image is vulnerable");
		expect(ctx.prompt).not.toContain("bump trivy findings please");
		expect(ctx.prompt).toContain("Current description: Fix trivy findings");
	});

	it("rewrite_rule carries the corrections", () => {
		seedPatternSession(db, "s1");
		const id = pattern(["s1"], {
			kind: "claude_md_rule",
			corrections: ["use httpx not requests", "stop using requests"],
		});
		const ctx = assembleDraftContext(db, id, "rewrite_rule", keptFor({}));
		expect(ctx.prompt).toContain("- use httpx not requests\n- stop using requests");
	});
});

describe("draft schema and estimate", () => {
	it("the JSON Schema requires every key; zod cuts long text and nulls empty rule fields", () => {
		expect(DRAFT_SCHEMA.required).toEqual(["name", "description", "body", "rule_text", "target_file"]);
		const r = DraftResultSchema.parse({
			name: " x ",
			description: "d",
			body: "b".repeat(50_000),
			rule_text: "  ",
			target_file: null,
		});
		expect(r).toMatchObject({ name: "x", rule_text: null, target_file: null });
		expect(r.body).toHaveLength(40_000);
		expect(DraftResultSchema.safeParse({ name: "x" }).success).toBe(false);
	});

	it("estimate = prompt chars / 4 input + 2,000 output on ai.model; null with no model", () => {
		seedPatternSession(db, "s1", { calls: TRIVY_CALLS });
		const id = pattern(["s1"]);
		const chars = estimateContextChars(db, id, "create");
		const expected = estimateCost({
			model: priceableModel("sonnet"),
			inputTokens: Math.ceil(chars / 4),
			outputTokens: 2000,
			cacheCreationTokens: 0,
			cacheCreation1hTokens: 0,
			cacheReadTokens: 0,
		});
		expect(estimateDraftCost(db, id, cfg({ model: "sonnet" }))).toBeCloseTo(expected as number, 12);
		expect(estimateDraftCost(db, id, cfg())).toBeNull(); // no usage model, no ai.model
		db.prepare("UPDATE usage SET model = 'claude-sonnet-4-5'").run();
		expect(estimateDraftCost(db, id, cfg())).toBeGreaterThan(0);
	});
});

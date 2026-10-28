import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildReviewPrompt,
	estimateReviewCost,
	REVIEW_SCHEMA,
	ReviewResultSchema,
	repoTaskLabels,
} from "../../../src/coach/review";
import type { Finding } from "../../../src/coach/types";
import { estimateCost } from "../../../src/collector/prices";
import { priceableModel } from "../../../src/collector/summarize";
import { type Config, ConfigSchema } from "../../../src/config";
import type { Db } from "../../../src/db/adapter";
import { upsertFindings } from "../../../src/db/queries/findings";
import { upsertReview } from "../../../src/db/queries/reviews";
import { seedDb } from "../../helpers/seed";
import { seedCoachSession } from "../../helpers/seed-coach";
import { type TmpHome, tmpHome } from "../../helpers/tmp-home";

const fixture = (name: string): Record<string, unknown> =>
	JSON.parse(readFileSync(join(import.meta.dirname, "../../fixtures/headless", name), "utf8"));
const cfg = (ai: Partial<Config["ai"]> = {}): Config => {
	const c = ConfigSchema.parse({});
	return { ...c, ai: { ...c.ai, ...ai } };
};

describe("ReviewResultSchema", () => {
	it("parses each fixture", () => {
		for (const name of ["review-drift.json", "review-multigoal.json", "review-low.json"]) {
			expect(ReviewResultSchema.safeParse(fixture(name)).success, name).toBe(true);
		}
	});

	it("rejects a missing confidence, an unknown friction kind and turn 0", () => {
		const { confidence: _c, ...noConfidence } = fixture("review-drift.json");
		expect(ReviewResultSchema.safeParse(noConfidence).success).toBe(false);
		const badKind = { ...fixture("review-low.json"), friction: [{ turn: 1, kind: "typo", note: "x" }] };
		expect(ReviewResultSchema.safeParse(badKind).success).toBe(false);
		const turn0 = { ...fixture("review-drift.json"), goal_changes: [{ turn: 0, from: "a", to: "b" }] };
		expect(ReviewResultSchema.safeParse(turn0).success).toBe(false);
	});

	it("cuts over-long text instead of rejecting it, and drops extra keys", () => {
		const long = { ...fixture("review-low.json"), better_approach: "x".repeat(5000), extra: 1 };
		const r = ReviewResultSchema.parse(long);
		expect(r.better_approach).toHaveLength(1500);
		expect(r).not.toHaveProperty("extra");
	});

	it("the JSON Schema requires every key and constrains the enums and turns", () => {
		expect(REVIEW_SCHEMA.required).toEqual([
			"goals",
			"goal_changes",
			"friction",
			"what_went_well",
			"better_approach",
			"suggested_first_prompt",
			"task_pattern",
			"confidence",
		]);
		expect(REVIEW_SCHEMA.properties.confidence.enum).toEqual(["low", "medium", "high"]);
		expect(REVIEW_SCHEMA.properties.friction.items.properties.kind.enum).toContain("missing_context");
		expect(REVIEW_SCHEMA.properties.goal_changes.items.properties.turn).toEqual({ type: "integer", minimum: 1 });
	});
});

describe("with a DB", () => {
	let h: TmpHome;
	let db: Db;
	beforeEach(() => {
		h = tmpHome();
		db = seedDb();
		db.prepare("INSERT INTO repos (repo_id, root_path, name) VALUES ('ra', '/a', 'a'), ('rb', '/b', 'b')").run();
	});
	afterEach(() => {
		db.close();
		h.cleanup();
	});

	const finding = (rule: string, message: string, evidence: Record<string, unknown>): Finding => ({
		rule,
		severity: "medium",
		message,
		evidence,
		costTokens: 100,
		target: "session",
	});
	const review = (sessionId: string, taskPattern: string, createdAt: string) =>
		upsertReview(db, {
			sessionId,
			schemaVersion: 1,
			result: { ...fixture("review-drift.json"), task_pattern: taskPattern },
			costUsd: 0.1,
			model: null,
			createdAt,
		});

	it("repoTaskLabels: distinct same-repo labels, most recently used first, within the limit", () => {
		for (const [id, repo] of [
			["s1", "ra"],
			["s2", "ra"],
			["s3", "ra"],
			["s4", "rb"],
		] as const)
			seedCoachSession(db, id, { repoId: repo });
		review("s1", "add endpoint", "2026-10-01T00:00:00.000Z");
		review("s2", "fix trivy findings", "2026-10-02T00:00:00.000Z");
		review("s3", "add endpoint", "2026-10-03T00:00:00.000Z");
		review("s4", "other repo", "2026-10-04T00:00:00.000Z");
		expect(repoTaskLabels(db, "ra")).toEqual(["add endpoint", "fix trivy findings"]);
		expect(repoTaskLabels(db, "ra", 1)).toEqual(["add endpoint"]);
		expect(repoTaskLabels(db, null)).toEqual([]);
	});

	it("the prompt holds the Tier 1 findings with evidence, the summary, the labels and the stored turns", () => {
		seedCoachSession(db, "s1", { repoId: "ra" });
		seedCoachSession(db, "s0", { repoId: "ra" });
		review("s0", "fix trivy findings", "2026-10-01T00:00:00.000Z");
		db.prepare("UPDATE sessions SET summary = 'Added a retry.', type_source = 'ai' WHERE session_id = 's1'").run();
		upsertFindings(
			db,
			"s1",
			["retry_loop", "context_churn"],
			[
				finding("retry_loop", "npm test failed 3 times", { key: "npm test", count: 3 }),
				finding("context_churn", "`a.ts` read 4 times", { key: "a.ts", reads: 4 }),
			],
		);
		upsertFindings(db, "s1", ["goal_drift"], [finding("goal_drift", "2 goals", {})]);
		const p = buildReviewPrompt(db, "s1");
		expect(p).not.toContain("[cc-debrief:"); // runClaude adds the sentinel
		expect(p).toContain("- retry_loop: npm test failed 3 times");
		expect(p).toContain('{"key":"npm test","count":3}');
		expect(p).toContain("- context_churn: `a.ts` read 4 times");
		expect(p).not.toContain('"target"');
		expect(p).not.toContain("goal_drift"); // Tier 2 findings are not evidence
		expect(p).toContain("## Summary\nAdded a retry.");
		expect(p).toContain("## Existing task labels for this repo\n- fix trivy findings");
		expect(p).toContain("## Session\nSession transcript (condensed from stored turns):");
		expect(p).toContain("You: step 1");
		expect(p).toMatch(/cite turn numbers/i);
		expect(p).toMatch(/no generic advice/i);
	});

	it("says none for no findings and no labels, and leaves out a heuristic summary", () => {
		seedCoachSession(db, "s1");
		db.prepare("UPDATE sessions SET summary = 'guess', type_source = 'heuristic' WHERE session_id = 's1'").run();
		const p = buildReviewPrompt(db, "s1");
		expect(p).toContain("## Tier 1 findings\nnone");
		expect(p).toContain("## Existing task labels for this repo\nnone");
		expect(p).not.toContain("## Summary");
	});

	it("estimate without history: the prompt's chars / 4 as uncached input plus 1,500 output on ai.model", () => {
		seedCoachSession(db, "s1");
		const ctx = Math.ceil(buildReviewPrompt(db, "s1").length / 4);
		const expected = estimateCost({
			model: priceableModel("sonnet"),
			inputTokens: ctx,
			outputTokens: 1500,
			cacheCreationTokens: 0,
			cacheCreation1hTokens: 0,
			cacheReadTokens: 0,
		});
		expect(expected).not.toBeNull();
		expect(estimateReviewCost(db, "s1", cfg({ model: "sonnet" }))).toBeCloseTo(expected as number, 12);
	});

	it("estimate without ai.model uses the session's last model", () => {
		seedCoachSession(db, "s1");
		db.prepare("UPDATE usage SET model = 'claude-sonnet-4-5' WHERE session_id = 's1'").run();
		expect(estimateReviewCost(db, "s1", cfg())).toBeCloseTo(
			estimateReviewCost(db, "s1", cfg({ model: "claude-sonnet-4-5" })) as number,
			12,
		);
	});

	it("estimate with 6 past review calls uses their median cost per 1k context", () => {
		seedCoachSession(db, "s1");
		[0.1, 0.2, 0.3, 0.4, 0.5, 0.6].forEach((usd, i) => {
			db.prepare(
				"INSERT INTO self_usage (feature, session_id, input_tokens, cost_usd, ts) VALUES ('review', ?, 10000, ?, ?)",
			).run(`c${i}`, usd, "2026-10-01T00:00:00.000Z");
		});
		const ctx = Math.ceil(buildReviewPrompt(db, "s1").length / 4);
		expect(estimateReviewCost(db, "s1", cfg())).toBeCloseTo((ctx / 1000) * 0.035, 12);
	});

	it("estimate is null with no model known (no usage model, no ai.model)", () => {
		seedCoachSession(db, "s1");
		expect(estimateReviewCost(db, "s1", cfg())).toBeNull();
		expect(estimateReviewCost(db, "s1", cfg({ model: "not-a-model" }))).toBeNull();
	});
});

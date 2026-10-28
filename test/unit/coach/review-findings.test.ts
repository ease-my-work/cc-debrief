import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type ReviewResult, ReviewResultSchema, reviewFindings } from "../../../src/coach/review";
import { ctx } from "../../helpers/ctx";

// ctx(): 10 turns of 150 non-cached tokens each (1,500 in all).
const result = (name: string, over: Partial<ReviewResult> = {}): ReviewResult => ({
	...ReviewResultSchema.parse(
		JSON.parse(readFileSync(join(import.meta.dirname, "../../fixtures/headless", name), "utf8")),
	),
	...over,
});

describe("reviewFindings", () => {
	it("three goals and no changes: one goal_drift without a turn, cost = tokens × (goals − 1) ÷ goals", () => {
		const [f, ...rest] = reviewFindings(result("review-multigoal.json"), ctx());
		expect(rest).toEqual([]);
		expect(f).toMatchObject({ rule: "goal_drift", severity: "medium", costTokens: 1000, target: "session" });
		expect(f.message).toBe(
			'3 goals: "fix trivy findings", "bump node", "update the README" — ≈1k tokens on the later goals; one session per goal, `/clear` between',
		);
		expect(f.evidence).toMatchObject({ changeTurn: null, turns: [], confidence: "medium" });
		expect(f.evidence).not.toHaveProperty("key"); // subject_key '': one per session
	});

	it("one goal change at turn 5: names the turn, cost = tokens of turns 5..end", () => {
		const r = result("review-drift.json", {
			friction: [],
			goal_changes: [{ turn: 5, from: "add retry to the billing client", to: "rename the config loader" }],
		});
		const [f] = reviewFindings(r, ctx());
		expect(f.costTokens).toBe(6 * 150);
		expect(f.message).toBe(
			'2 goals: add retry to the billing client (turns 1–4), then "rename the config loader" at turn 5 — 900 tokens on the later goal; one session per goal, `/clear` between',
		);
		expect(f.evidence).toMatchObject({ changeTurn: 5, turns: [5], confidence: "high" });
	});

	it("two goals and no change: no goal_drift", () => {
		const r = result("review-drift.json", { goal_changes: [], friction: [] });
		expect(reviewFindings(r, ctx())).toEqual([]);
	});

	it("friction entries: one low review_friction each, keyed by turn and kind, costing that turn", () => {
		const r = result("review-drift.json", { goal_changes: [], goals: ["one"] });
		const fs = reviewFindings(r, ctx());
		expect(fs.map((f) => [f.rule, f.severity, f.evidence.key, f.costTokens])).toEqual([
			["review_friction", "low", "turn:2:missing_context", 150],
			["review_friction", "low", "turn:4:scope_creep", 150],
		]);
		expect(fs[0].message).toBe(
			"Missing context at turn 2: the retry policy lived in docs/adr-12.md, which was never mentioned",
		);
		expect(fs[0].evidence.turns).toEqual([2]);
	});

	it("a turn outside the session: finding kept, turn dropped from the message, cost 0", () => {
		const r = result("review-low.json", { friction: [{ turn: 99, kind: "ambiguous_ask", note: "vague" }] });
		const [f] = reviewFindings(r, ctx());
		expect(f).toMatchObject({ message: "Ambiguous ask: vague", costTokens: 0 });
		expect(f.evidence).toMatchObject({ key: "turn:99:ambiguous_ask", turns: [] });
		const drift = reviewFindings(
			result("review-drift.json", { friction: [], goal_changes: [{ turn: 40, from: "a", to: "b" }] }),
			ctx(),
		)[0];
		expect(drift).toMatchObject({ rule: "goal_drift", costTokens: 0 });
		expect(drift.message).not.toMatch(/turn/);
	});

	it("confidence low: every finding carries evidence.confidence = low", () => {
		const fs = reviewFindings(result("review-low.json", { goals: ["a", "b", "c"] }), ctx());
		expect(fs.length).toBe(2);
		for (const f of fs) expect(f.evidence.confidence).toBe("low");
	});
});

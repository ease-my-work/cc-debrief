import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reviewEligibility } from "../../../src/coach/review";
import type { Finding } from "../../../src/coach/types";
import { type Config, ConfigSchema } from "../../../src/config";
import type { Db } from "../../../src/db/adapter";
import { upsertFindings } from "../../../src/db/queries/findings";
import { upsertReview } from "../../../src/db/queries/reviews";
import { addRuleVotes } from "../../../src/db/queries/ruleFeedback";
import { seedDb } from "../../helpers/seed";
import { type TmpHome, tmpHome } from "../../helpers/tmp-home";

const NOW = new Date("2026-10-10T12:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const cfg = (review: Partial<Config["ai"]["review"]> = {}): Config => {
	const c = ConfigSchema.parse({});
	return { ...c, ai: { ...c.ai, review: { ...c.ai.review, enabled: true, auto: true, ...review } } };
};

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

type Seed = {
	turns?: number;
	tokens?: number;
	cacheRead?: number;
	capture?: string;
	endEvent?: boolean;
	lastLine?: string;
};

/** A session with `turns` turns, one usage row of `tokens` input, a SessionEnd event unless endEvent is false. */
function seed(id: string, s: Seed = {}): string {
	db.prepare("INSERT INTO sessions (session_id, started_at, ended_at, capture) VALUES (?, ?, ?, ?)").run(
		id,
		hoursAgo(30),
		s.lastLine ?? hoursAgo(2),
		s.capture ?? "hooks",
	);
	const turn = db.prepare("INSERT INTO turns (session_id, seq, user_text, started_at) VALUES (?, ?, 'x', ?)");
	for (let i = 1; i <= (s.turns ?? 21); i++) turn.run(id, i, hoursAgo(3));
	db.prepare(
		"INSERT INTO usage (session_id, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, ts) VALUES (?, ?, 0, 0, ?, ?)",
	).run(id, s.tokens ?? 1000, s.cacheRead ?? 0, hoursAgo(3));
	if (s.endEvent !== false) {
		db.prepare("INSERT INTO events (session_id, event, ts, payload) VALUES (?, 'SessionEnd', ?, '{}')").run(
			id,
			hoursAgo(2),
		);
	}
	return id;
}

const high = (rule: string): Finding => ({
	rule,
	severity: "high",
	message: "m",
	evidence: {},
	costTokens: 10,
	target: "session",
});

describe("reviewEligibility", () => {
	it("hooks, ended, 21 turns, reviews and auto on: eligible and auto-eligible", () => {
		expect(reviewEligibility(db, seed("s"), cfg(), NOW)).toEqual({
			ended: true,
			crossesThreshold: true,
			eligible: true,
			autoEligible: true,
			reasons: [],
		});
	});

	it("20 turns, tokens below, no high finding: neither", () => {
		const e = reviewEligibility(db, seed("s", { turns: 20 }), cfg(), NOW);
		expect(e).toMatchObject({ crossesThreshold: false, eligible: false, autoEligible: false });
		expect(e.reasons).toEqual(["below_threshold"]);
	});

	it("non-cached tokens 200,001 cross the threshold; 5M cache reads alone do not", () => {
		expect(reviewEligibility(db, seed("a", { turns: 2, tokens: 200_001 }), cfg(), NOW).eligible).toBe(true);
		expect(reviewEligibility(db, seed("b", { turns: 2, tokens: 10, cacheRead: 5_000_000 }), cfg(), NOW).eligible).toBe(
			false,
		);
	});

	it("a high Tier 1 finding crosses the threshold unless its rule is demoted", () => {
		seed("s", { turns: 2 });
		upsertFindings(db, "s", ["retry_loop"], [high("retry_loop")]);
		expect(reviewEligibility(db, "s", cfg(), NOW).eligible).toBe(true);
		addRuleVotes(db, "retry_loop", { helpful: 0, notHelpful: 3 }, NOW);
		expect(reviewEligibility(db, "s", cfg(), NOW)).toMatchObject({ eligible: false, autoEligible: false });
	});

	it("a high Tier 2 finding does not count", () => {
		seed("s", { turns: 2 });
		upsertFindings(db, "s", ["goal_drift"], [high("goal_drift")]);
		expect(reviewEligibility(db, "s", cfg(), NOW).eligible).toBe(false);
	});

	it("imported (backfill), 30 turns: eligible, not auto-eligible", () => {
		const e = reviewEligibility(db, seed("s", { turns: 30, capture: "backfill" }), cfg(), NOW);
		expect(e).toMatchObject({ eligible: true, autoEligible: false, reasons: ["imported"] });
	});

	it("no SessionEnd and a line 2 h ago: open, neither; 25 h ago: ended", () => {
		const open = reviewEligibility(db, seed("a", { endEvent: false, lastLine: hoursAgo(2) }), cfg(), NOW);
		expect(open).toMatchObject({ ended: false, eligible: false, autoEligible: false, reasons: ["open"] });
		const quiet = reviewEligibility(db, seed("b", { endEvent: false, lastLine: hoursAgo(25) }), cfg(), NOW);
		expect(quiet).toMatchObject({ ended: true, eligible: true });
	});

	it("already reviewed: neither", () => {
		seed("s");
		upsertReview(db, {
			sessionId: "s",
			schemaVersion: 1,
			result: {},
			costUsd: 0.1,
			model: null,
			createdAt: hoursAgo(1),
		});
		expect(reviewEligibility(db, "s", cfg(), NOW)).toMatchObject({ eligible: false, reasons: ["reviewed"] });
	});

	it("reviews off: neither, with reviews_disabled", () => {
		const e = reviewEligibility(db, seed("s"), cfg({ enabled: false }), NOW);
		expect(e).toMatchObject({ eligible: false, autoEligible: false });
		expect(e.reasons).toContain("reviews_disabled");
	});

	it("auto off: eligible, not auto-eligible", () => {
		expect(reviewEligibility(db, seed("s"), cfg({ auto: false }), NOW)).toMatchObject({
			eligible: true,
			autoEligible: false,
			reasons: ["auto_off"],
		});
	});
});

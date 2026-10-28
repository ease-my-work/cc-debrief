import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reviewSession } from "../../../src/coach/review";
import type { Finding } from "../../../src/coach/types";
import { estimateCost } from "../../../src/collector/prices";
import { type Config, ConfigSchema } from "../../../src/config";
import type { Db } from "../../../src/db/adapter";
import { upsertFindings } from "../../../src/db/queries/findings";
import { getReview } from "../../../src/db/queries/reviews";
import { type FakeClaude, fakeClaude, successResult } from "../../helpers/fake-claude";
import { seedDb } from "../../helpers/seed";
import { seedCoachSession } from "../../helpers/seed-coach";
import { type TmpHome, tmpHome } from "../../helpers/tmp-home";

const fixture = (name: string): Record<string, unknown> =>
	JSON.parse(readFileSync(join(import.meta.dirname, "../../fixtures/headless", name), "utf8"));
const DRIFT = fixture("review-drift.json");

let h: TmpHome;
let db: Db;
let fake: FakeClaude;
let restore: () => void;
beforeEach(() => {
	h = tmpHome();
	db = seedDb();
	fake = fakeClaude(h.home);
	restore = fake.install();
	fake.scenario({ stdout: successResult(DRIFT) });
});
afterEach(() => {
	restore();
	db.close();
	h.cleanup();
});

const cfg = (review: Partial<Config["ai"]["review"]> = {}): Config => {
	const c = ConfigSchema.parse({});
	return { ...c, ai: { ...c.ai, review: { ...c.ai.review, enabled: true, ...review } } };
};
const spawns = () => fake.invocations().length;
const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;

/** seedCoachSession (4 turns, 1000 input tokens each) plus a SessionEnd event; `open` leaves it out. */
function seed(id = "s1", o: { open?: boolean; turns?: number } = {}): string {
	seedCoachSession(db, id, { repoId: null });
	if (!o.open) {
		db.prepare("INSERT INTO events (session_id, event, ts, payload) VALUES (?, 'SessionEnd', ?, '{}')").run(
			id,
			new Date(Date.now() - 600_000).toISOString(),
		);
	}
	return id;
}
const click = (id = "s1", c = cfg()) => reviewSession(db, id, c, { trigger: "click" });

describe("reviewSession", () => {
	it("click, valid result: stores the review with its own-usage cost, self_usage and the Tier 2 findings", async () => {
		seed();
		const r = await click();
		expect(r.status).toBe("done");
		// successResult(): haiku 4.5, 10 in, 92 out, 1,531 one-hour cache writes, 49,643 cache reads; not 0.0123
		const own = estimateCost({
			model: "claude-haiku-4-5-20251001",
			inputTokens: 10,
			outputTokens: 92,
			cacheCreationTokens: 1531,
			cacheCreation1hTokens: 1531,
			cacheReadTokens: 49643,
		}) as number;
		expect(r.costUsd).toBeCloseTo(own, 12);
		const review = getReview(db, "s1");
		expect(review).toMatchObject({ id: r.reviewId, schemaVersion: 1, model: "claude-haiku-4-5-20251001" });
		expect(review?.costUsd).toBeCloseTo(own, 12);
		expect(review?.result).toMatchObject({ task_pattern: "add retry", confidence: "high" });
		expect(db.prepare("SELECT feature, target_session_id FROM self_usage").all()).toEqual([
			{ feature: "review", target_session_id: "s1" },
		]);
		expect(
			db.prepare("SELECT rule, subject_key FROM findings WHERE session_id = 's1' ORDER BY rule, subject_key").all(),
		).toEqual([
			{ rule: "goal_drift", subject_key: "" },
			{ rule: "review_friction", subject_key: "turn:2:missing_context" },
			{ rule: "review_friction", subject_key: "turn:4:scope_creep" },
		]);
	});

	it("sends the stored-turns prompt after the review sentinel, with no tools and no resume", async () => {
		seed();
		await click();
		const [inv] = fake.invocations();
		expect(inv.stdin.split("\n")[0]).toBe("[cc-debrief:review]");
		expect(inv.stdin).toContain("Session transcript (condensed from stored turns):");
		expect(inv.env).toEqual({ CC_DEBRIEF_INTERNAL: "1", CC_DEBRIEF_FEATURE: "review" });
		expect(inv.argv).toEqual(expect.arrayContaining(["--tools", "", "--strict-mcp-config", "--max-budget-usd"]));
		expect(inv.argv).not.toContain("--resume");
		expect(inv.argv).not.toContain("--fork-session");
	});

	it("reviews disabled: disabled, no spawn", async () => {
		seed();
		expect(await click("s1", cfg({ enabled: false }))).toMatchObject({ status: "disabled" });
		expect(spawns()).toBe(0);
	});

	it("cap reached: capped, no spawn", async () => {
		seed();
		db.prepare("INSERT INTO ai_calls (feature, ts) VALUES ('review', ?)").run(new Date().toISOString());
		expect(await click("s1", cfg({ maxPerDay: 1 }))).toMatchObject({ status: "capped" });
		expect(spawns()).toBe(0);
	});

	it("summary calls do not count toward the review cap", async () => {
		seed();
		db.prepare("INSERT INTO ai_calls (feature, ts) VALUES ('summary', ?)").run(new Date().toISOString());
		expect((await click("s1", cfg({ maxPerDay: 1 }))).status).toBe("done");
	});

	it("a second concurrent review of the session: busy", async () => {
		seed();
		fake.scenario({ stdout: successResult(DRIFT), delayMs: 1000 });
		const [a, b] = await Promise.all([click(), click()]);
		expect([a.status, b.status].sort()).toEqual(["busy", "done"]);
		expect(spawns()).toBe(1);
	});

	it("open session: open, no spawn", async () => {
		seed("s1", { open: true });
		expect(await click()).toMatchObject({ status: "open" });
		expect(spawns()).toBe(0);
	});

	it("auto trigger on a session that is not auto-eligible: skipped with the reasons, no spawn", async () => {
		seed(); // 4 turns, 4,000 tokens: below the threshold
		const r = await reviewSession(db, "s1", cfg({ auto: true }), { trigger: "auto" });
		expect(r).toMatchObject({ status: "skipped", reason: "below_threshold" });
		expect(spawns()).toBe(0);
	});

	it("auto trigger on an auto-eligible session runs", async () => {
		seed();
		const r = await reviewSession(db, "s1", cfg({ auto: true, autoThreshold: { turns: 3, tokens: 200_000 } }), {
			trigger: "auto",
		});
		expect(r.status).toBe("done");
	});

	it("claude exit 1: error with the reason, no reviews row, no retry", async () => {
		seed();
		fake.scenario({ exitCode: 1, stderr: "boom" });
		const r = await click();
		expect(r.status).toBe("error");
		expect(r.reason).toMatch(/^exit 1/);
		expect(count("SELECT count(*) AS n FROM reviews")).toBe(0);
		expect(count("SELECT count(*) AS n FROM ai_calls")).toBe(1);
	});

	it("a schema-invalid result: error schema, cost in self_usage, nothing in reviews", async () => {
		seed();
		fake.scenario({ stdout: successResult({ goals: ["x"], confidence: "certain" }) });
		const r = await click();
		expect(r.status).toBe("error");
		expect(r.reason).toMatch(/^schema/);
		expect(count("SELECT count(*) AS n FROM self_usage WHERE feature = 'review' AND cost_usd > 0")).toBe(1);
		expect(count("SELECT count(*) AS n FROM reviews")).toBe(0);
		expect(spawns()).toBe(1);
	});

	it("a budget error is an error, not retried", async () => {
		seed();
		fake.scenario({ stdout: successResult(undefined, { is_error: true, subtype: "error_max_budget_usd" }) });
		const r = await click();
		expect(r).toMatchObject({ status: "error" });
		expect(r.reason).toMatch(/^budget/);
		expect(spawns()).toBe(1);
	});

	it("re-review: replaces the row; a finding produced again keeps its feedback, one not produced goes", async () => {
		seed();
		await click();
		db.prepare("UPDATE findings SET feedback = 'helpful' WHERE subject_key = 'turn:2:missing_context'").run();
		db.prepare("UPDATE reviews SET feedback = 'helpful'").run();
		fake.scenario({
			stdout: successResult({
				...DRIFT,
				task_pattern: "add retry v2",
				friction: [(DRIFT.friction as object[])[0]],
			}),
		});
		const again = await click();
		expect(again.status).toBe("done");
		expect(count("SELECT count(*) AS n FROM reviews")).toBe(1);
		expect(getReview(db, "s1")).toMatchObject({ feedback: null, result: { task_pattern: "add retry v2" } });
		expect(
			db
				.prepare("SELECT subject_key, feedback FROM findings WHERE rule = 'review_friction' ORDER BY subject_key")
				.all(),
		).toEqual([{ subject_key: "turn:2:missing_context", feedback: "helpful" }]);
	});

	it("re-review leaves Tier 1 findings alone", async () => {
		seed();
		const t1: Finding = {
			rule: "retry_loop",
			severity: "medium",
			message: "m",
			evidence: { key: "npm test" },
			costTokens: 1,
			target: "session",
		};
		upsertFindings(db, "s1", ["retry_loop"], [t1]);
		await click();
		expect(count("SELECT count(*) AS n FROM findings WHERE rule = 'retry_loop'")).toBe(1);
	});

	it("redacts a secret the model put in the result", async () => {
		seed();
		const secret = `sk-ant-api03-${"A".repeat(40)}`;
		fake.scenario({ stdout: successResult({ ...DRIFT, better_approach: `Rotate ${secret} first.` }) });
		await click();
		const stored = getReview(db, "s1")?.result as { better_approach: string };
		expect(stored.better_approach).toBe("Rotate [REDACTED] first.");
	});
});

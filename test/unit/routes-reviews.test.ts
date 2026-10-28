import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setConfigValue } from "../../src/config";
import type { Db } from "../../src/db/adapter";
import { locksDir } from "../../src/paths";
import { createApp } from "../../src/server/app";
import { waitForReviewJob } from "../../src/server/jobs";
import type {
	ImprovementsResponse,
	ReviewResponse,
	SessionDetail,
	SessionsResponse,
	StatusResponse,
} from "../../src/server/types";
import { type FakeClaude, fakeClaude, successResult } from "../helpers/fake-claude";
import { seedDb } from "../helpers/seed";
import { seedCoachSession } from "../helpers/seed-coach";
import { type TmpHome, tmpHome } from "../helpers/tmp-home";

const HOST = { host: "127.0.0.1:4242" };
const JSON_HEADERS = { ...HOST, "content-type": "application/json" };
const fixture = (name: string): Record<string, unknown> =>
	JSON.parse(readFileSync(join(import.meta.dirname, "../fixtures/headless", name), "utf8"));
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
	setConfigValue("ai.review.enabled", "true");
});
afterEach(async () => {
	await waitForReviewJob();
	restore();
	db.close();
	h.cleanup();
});

const app = () => createApp(db, { port: 4242, uiDir: "/x" });
const get = async <T>(path: string) => (await (await app().request(path, { headers: HOST })).json()) as T;
const post = async (path: string, body: unknown = {}, headers: Record<string, string> = JSON_HEADERS) => {
	const r = await app().request(path, { method: "POST", headers, body: JSON.stringify(body) });
	return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};
const errorCode = (b: Record<string, unknown>) => (b.error as { code: string }).code;
const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;

/** A hook-captured session that ended 10 min ago; 4 turns of 1000 tokens (below the auto threshold unless `turns`). */
function seed(id: string, o: { open?: boolean; extraTurns?: number; startedAt?: string } = {}): string {
	seedCoachSession(db, id, { startedAt: o.startedAt });
	const turn = db.prepare("INSERT INTO turns (session_id, seq, user_text) VALUES (?, ?, 'more')");
	for (let i = 0; i < (o.extraTurns ?? 0); i++) turn.run(id, 5 + i);
	if (!o.open) {
		db.prepare("INSERT INTO events (session_id, event, ts, payload) VALUES (?, 'SessionEnd', ?, '{}')").run(
			id,
			new Date(Date.now() - 600_000).toISOString(),
		);
	}
	return id;
}
/** Eligible: ended and over 20 turns. */
const eligible = (id: string, startedAt?: string) => seed(id, { extraTurns: 17, startedAt });

describe("POST /api/sessions/:id/review", () => {
	it("200 with the review id, its actual cost and the reviewed band", async () => {
		seed("s1");
		const r = await post("/api/sessions/s1/review");
		expect(r.status).toBe(200);
		const body = r.body as unknown as ReviewResponse;
		expect(body.reviewId).toEqual(expect.any(Number));
		expect(body.costUsd).toBeGreaterThan(0);
		expect(body.band).toMatchObject({
			state: "reviewed",
			tier2: {
				betterApproach: DRIFT.better_approach,
				whatWentWell: DRIFT.what_went_well,
				suggestedFirstPrompt: DRIFT.suggested_first_prompt,
				confidence: "high",
				model: "claude-haiku-4-5-20251001",
				feedback: null,
			},
		});
		expect(body.band.findings.map((f) => f.rule)).toEqual(expect.arrayContaining(["goal_drift", "review_friction"]));
	});

	it("404 for an unknown session", async () => {
		expect((await post("/api/sessions/nope/review")).status).toBe(404);
	});

	it("409 reviews_disabled with reviews off, no spawn", async () => {
		setConfigValue("ai.review.enabled", "false");
		seed("s1");
		const r = await post("/api/sessions/s1/review");
		expect([r.status, errorCode(r.body)]).toEqual([409, "reviews_disabled"]);
		expect(fake.invocations()).toHaveLength(0);
	});

	it("409 session_open for a session that has not ended", async () => {
		seed("s1", { open: true });
		const r = await post("/api/sessions/s1/review");
		expect([r.status, errorCode(r.body)]).toEqual([409, "session_open"]);
	});

	it("429 review_cap_reached at the cap, no spawn", async () => {
		setConfigValue("ai.review.maxPerDay", "1");
		db.prepare("INSERT INTO ai_calls (feature, ts) VALUES ('review', ?)").run(new Date().toISOString());
		seed("s1");
		const r = await post("/api/sessions/s1/review");
		expect([r.status, errorCode(r.body)]).toEqual([429, "review_cap_reached"]);
		expect(fake.invocations()).toHaveLength(0);
	});

	it("409 review_in_flight while another worker reviews the session", async () => {
		seed("s1");
		mkdirSync(locksDir(), { recursive: true });
		writeFileSync(
			join(locksDir(), "review-s1.lock"),
			JSON.stringify({ pid: process.ppid, startedAt: new Date().toISOString() }),
		);
		const r = await post("/api/sessions/s1/review");
		expect([r.status, errorCode(r.body)]).toEqual([409, "review_in_flight"]);
		expect((await get<SessionDetail>("/api/sessions/s1")).review?.state).toBe("running");
	});

	it("502 review_failed with the reason when claude fails", async () => {
		seed("s1");
		fake.scenario({ exitCode: 1, stderr: "boom" });
		const r = await post("/api/sessions/s1/review");
		expect([r.status, errorCode(r.body)]).toEqual([502, "review_failed"]);
		expect((r.body.error as { message: string }).message).toMatch(/^exit 1/);
	});

	it("rejects a cross-origin POST", async () => {
		seed("s1");
		const r = await post("/api/sessions/s1/review", {}, { ...JSON_HEADERS, origin: "https://evil.example" });
		expect(r.status).toBe(403);
		expect(fake.invocations()).toHaveLength(0);
	});
});

describe("the review band and list badge", () => {
	it("band: disabled with reviews off, else not_reviewed with an estimate, then reviewed", async () => {
		seed("s1");
		db.prepare("UPDATE usage SET model = 'claude-sonnet-4-5'").run();
		setConfigValue("ai.review.enabled", "false");
		expect((await get<SessionDetail>("/api/sessions/s1")).review).toMatchObject({ state: "disabled", estUsd: null });
		setConfigValue("ai.review.enabled", "true");
		const before = (await get<SessionDetail>("/api/sessions/s1")).review;
		expect(before).toMatchObject({ state: "not_reviewed", capReached: false, tier2: null });
		expect(before?.estUsd).toBeGreaterThan(0);
		await post("/api/sessions/s1/review");
		expect((await get<SessionDetail>("/api/sessions/s1")).review?.state).toBe("reviewed");
	});

	it("collapses the findings of a low-confidence review", async () => {
		seed("s1");
		fake.scenario({ stdout: successResult(fixture("review-low.json")) });
		await post("/api/sessions/s1/review");
		const band = (await get<SessionDetail>("/api/sessions/s1")).review;
		const friction = band?.findings.find((f) => f.rule === "review_friction");
		expect(friction?.collapsed).toBe(true);
	});

	it("capReached once today's review cap is used", async () => {
		setConfigValue("ai.review.maxPerDay", "1");
		db.prepare("INSERT INTO ai_calls (feature, ts) VALUES ('review', ?)").run(new Date().toISOString());
		seed("s1");
		expect((await get<SessionDetail>("/api/sessions/s1")).review?.capReached).toBe(true);
	});

	it("list rows: eligible with an estimate, reviewed, none; null with reviews off", async () => {
		eligible("e1");
		seed("n1");
		eligible("r1");
		db.prepare("UPDATE usage SET model = 'claude-sonnet-4-5'").run();
		await post("/api/sessions/r1/review");
		const items = (await get<SessionsResponse>("/api/sessions?range=7d")).items;
		const byId = new Map(items.map((i) => [i.id, i.review]));
		expect(byId.get("e1")?.state).toBe("eligible");
		expect(byId.get("e1")?.estUsd).toBeGreaterThan(0);
		expect(byId.get("r1")).toEqual({ state: "reviewed", estUsd: null });
		expect(byId.get("n1")).toEqual({ state: "none", estUsd: null });
		setConfigValue("ai.review.enabled", "false");
		expect((await get<SessionsResponse>("/api/sessions?range=7d")).items.every((i) => i.review === null)).toBe(true);
	});
});

describe("POST /api/sessions/:id/review/feedback", () => {
	it("one action per rule over the review's findings, and the value on the review", async () => {
		seed("s1");
		await post("/api/sessions/s1/review");
		const r = await post("/api/sessions/s1/review/feedback", { value: "not_helpful" });
		expect(r).toEqual({ status: 200, body: { demoted: [] } });
		expect(db.prepare("SELECT rule, not_helpful FROM rule_feedback ORDER BY rule").all()).toEqual([
			{ rule: "goal_drift", not_helpful: 1 },
			{ rule: "review_friction", not_helpful: 1 }, // two friction findings, one vote
		]);
		expect(count("SELECT count(*) AS n FROM findings WHERE session_id = 's1' AND feedback = 'not_helpful'")).toBe(3);
		expect(db.prepare("SELECT feedback FROM reviews").get()).toEqual({ feedback: "not_helpful" });
		// the same value again counts nothing; switching moves the vote
		await post("/api/sessions/s1/review/feedback", { value: "not_helpful" });
		await post("/api/sessions/s1/review/feedback", { value: "helpful" });
		expect(db.prepare("SELECT rule, helpful, not_helpful FROM rule_feedback ORDER BY rule").all()).toEqual([
			{ rule: "goal_drift", helpful: 1, not_helpful: 0 },
			{ rule: "review_friction", helpful: 1, not_helpful: 0 },
		]);
	});

	it("keeps the value for a review with no findings", async () => {
		seed("s1");
		fake.scenario({ stdout: successResult({ ...DRIFT, goal_changes: [], friction: [] }) });
		await post("/api/sessions/s1/review");
		expect((await post("/api/sessions/s1/review/feedback", { value: "helpful" })).status).toBe(200);
		expect(db.prepare("SELECT feedback FROM reviews").get()).toEqual({ feedback: "helpful" });
	});

	it("404 without a review; 400 for a bad value", async () => {
		seed("s1");
		expect((await post("/api/sessions/s1/review/feedback", { value: "helpful" })).status).toBe(404);
		expect((await post("/api/sessions/s1/review/feedback", { value: "meh" })).status).toBe(400);
	});
});

describe("digest footer and Review all", () => {
	it("footer: reviews this week with their cost, eligible unreviewed with the summed estimate", async () => {
		db.prepare("UPDATE usage SET model = 'claude-sonnet-4-5'").run();
		eligible("a");
		eligible("b");
		eligible("old", new Date(Date.now() - 9 * 86_400_000).toISOString());
		db.prepare("UPDATE usage SET model = 'claude-sonnet-4-5'").run();
		await post("/api/sessions/a/review");
		const f = (await get<ImprovementsResponse>("/api/improvements?range=7d")).footer;
		expect(f.reviewsThisWeek).toBe(1);
		expect(f.reviewCostUsd).toBeGreaterThan(0);
		expect(f.eligibleUnreviewed).toBe(1); // b; old started 9 days ago
		expect(f.estReviewAllUsd).toBeGreaterThan(0);
	});

	it("estReviewAllUsd is null when an estimate is unknown", async () => {
		eligible("a"); // no model anywhere
		expect((await get<ImprovementsResponse>("/api/improvements?range=7d")).footer.estReviewAllUsd).toBeNull();
	});

	it("runs the eligible sessions of the last 7 days oldest first, with progress, and 409 while running", async () => {
		const old = new Date(Date.now() - 5 * 3_600_000).toISOString();
		const newer = new Date(Date.now() - 3 * 3_600_000).toISOString();
		eligible("b", newer);
		eligible("a", old);
		fake.scenario({ stdout: successResult(DRIFT), delayMs: 300 });
		const r = await post("/api/reviews/run", { scope: "eligible_7d" });
		expect(r).toMatchObject({ status: 200, body: { queued: 2 } });
		expect((await get<StatusResponse>("/api/status")).reviewJob).toEqual({ done: 0, total: 2 });
		expect((await post("/api/reviews/run", { scope: "eligible_7d" })).status).toBe(409);
		await waitForReviewJob();
		expect((await get<StatusResponse>("/api/status")).reviewJob).toBeNull();
		expect(fake.invocations().map((i) => i.stdin.includes("step 1"))).toEqual([true, true]);
		expect(db.prepare("SELECT session_id FROM reviews ORDER BY id").all()).toEqual([
			{ session_id: "a" },
			{ session_id: "b" },
		]);
	});

	it("stops at the cap", async () => {
		setConfigValue("ai.review.maxPerDay", "1");
		eligible("a", new Date(Date.now() - 5 * 3_600_000).toISOString());
		eligible("b", new Date(Date.now() - 4 * 3_600_000).toISOString());
		eligible("c", new Date(Date.now() - 3 * 3_600_000).toISOString());
		await post("/api/reviews/run", { scope: "eligible_7d" });
		await waitForReviewJob();
		expect(fake.invocations()).toHaveLength(1);
	});

	it("stops after 3 errors in a row", async () => {
		fake.scenario({ exitCode: 1, stderr: "boom" });
		for (let i = 0; i < 5; i++) eligible(`s${i}`, new Date(Date.now() - (10 - i) * 3_600_000).toISOString());
		await post("/api/reviews/run", { scope: "eligible_7d" });
		await waitForReviewJob();
		expect(fake.invocations()).toHaveLength(3);
	});

	it("409 with reviews off, 422 for another scope", async () => {
		expect((await post("/api/reviews/run", { scope: "all" })).status).toBe(422);
		setConfigValue("ai.review.enabled", "false");
		expect((await post("/api/reviews/run", { scope: "eligible_7d" })).status).toBe(409);
	});
});

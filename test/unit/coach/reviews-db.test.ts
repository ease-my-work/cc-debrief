import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RULE_LABELS } from "../../../src/coach/labels";
import { type Db, openDb } from "../../../src/db/adapter";
import { migrate } from "../../../src/db/migrate";
import init001 from "../../../src/db/migrations/001_init.sql";
import inventory002 from "../../../src/db/migrations/002_inventory.sql";
import selfUsage003 from "../../../src/db/migrations/003_self_usage.sql";
import findings004 from "../../../src/db/migrations/004_findings.sql";
import removeRules005 from "../../../src/db/migrations/005_remove_rules.sql";
import findingDates006 from "../../../src/db/migrations/006_finding_dates.sql";
import { getMeta, setMeta } from "../../../src/db/queries/meta";
import {
	getReview,
	type ReviewRowInput,
	reviewCostPer1kContext,
	reviewsThisWeek,
	setReviewFeedback,
	upsertReview,
} from "../../../src/db/queries/reviews";
import { seedDb } from "../../helpers/seed";
import { type TmpHome, tmpHome } from "../../helpers/tmp-home";

let t: TmpHome;
let db: Db;
beforeEach(() => {
	t = tmpHome();
});
afterEach(() => {
	db?.close();
	t.cleanup();
});

const NOW = new Date("2026-10-10T12:00:00.000Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

const review = (over: Partial<ReviewRowInput> = {}): ReviewRowInput => ({
	sessionId: "s1",
	schemaVersion: 1,
	result: { goals: ["a"], confidence: "high" },
	costUsd: 0.12,
	model: "claude-sonnet-4-5",
	createdAt: NOW.toISOString(),
	...over,
});

function addSessions(...ids: string[]): void {
	for (const id of ids) db.prepare("INSERT INTO sessions (session_id, started_at) VALUES (?, ?)").run(id, daysAgo(1));
}

function addReviewCall(n: number, costUsd: number, contextTokens: number): void {
	db.prepare(
		`INSERT INTO self_usage (feature, session_id, input_tokens, cache_read_tokens, cost_usd, ts)
		 VALUES ('review', ?, ?, ?, ?, ?)`,
	).run(`call-${n}`, contextTokens / 2, contextTokens / 2, costUsd, daysAgo(n));
}

describe("migration 007_reviews", () => {
	it("upgrades a v6 DB to v7 with the reviews table", () => {
		db = openDb();
		db.transaction(() => {
			for (const sql of [init001, inventory002, selfUsage003, findings004, removeRules005, findingDates006])
				db.exec(sql);
			setMeta(db, "schema_version", "6");
		});
		migrate(db, { to: 8 });
		expect(getMeta(db, "schema_version")).toBe("8");
		const cols = db
			.prepare("PRAGMA table_info(reviews)")
			.all<{ name: string }>()
			.map((c) => c.name);
		expect(cols).toEqual([
			"id",
			"session_id",
			"schema_version",
			"result",
			"cost_usd",
			"model",
			"created_at",
			"feedback",
			"agent",
		]);
	});

	it("deletes a session's review with the session", () => {
		db = seedDb();
		addSessions("s1");
		upsertReview(db, review());
		db.prepare("DELETE FROM sessions WHERE session_id = 's1'").run();
		expect(db.prepare("SELECT count(*) AS n FROM reviews").get()).toEqual({ n: 0 });
	});
});

describe("review queries", () => {
	beforeEach(() => {
		db = seedDb();
		addSessions("s1", "s2", "s3");
	});

	it("upsertReview keeps one row per session, replaces the result and clears feedback", () => {
		const first = upsertReview(db, review());
		setReviewFeedback(db, "s1", "helpful");
		expect(getReview(db, "s1")?.feedback).toBe("helpful");
		const second = upsertReview(db, review({ result: { goals: ["b"] }, costUsd: 0.2 }));
		expect(second).toBe(first);
		const r = getReview(db, "s1");
		expect(r).toMatchObject({ id: first, sessionId: "s1", costUsd: 0.2, feedback: null, result: { goals: ["b"] } });
		expect(db.prepare("SELECT count(*) AS n FROM reviews").get()).toEqual({ n: 1 });
	});

	it("getReview is null for an unreviewed session", () => {
		expect(getReview(db, "s2")).toBeNull();
	});

	it("reviewsThisWeek counts the rolling 7 days and sums cost", () => {
		upsertReview(db, review({ sessionId: "s1", createdAt: daysAgo(1), costUsd: 0.1 }));
		upsertReview(db, review({ sessionId: "s2", createdAt: daysAgo(6.9), costUsd: null }));
		upsertReview(db, review({ sessionId: "s3", createdAt: daysAgo(7.1), costUsd: 5 }));
		expect(reviewsThisWeek(db, NOW)).toEqual({ count: 2, costUsd: 0.1 });
	});

	it("reviewCostPer1kContext is null with 4 review calls", () => {
		for (let i = 1; i <= 4; i++) addReviewCall(i, 0.1, 10_000);
		expect(reviewCostPer1kContext(db)).toBeNull();
	});

	it("reviewCostPer1kContext is the median with 5 (odd) and 6 (even) calls", () => {
		// per 1k: 0.01, 0.02, 0.03, 0.04, 0.05
		[0.1, 0.2, 0.3, 0.4, 0.5].forEach((c, i) => {
			addReviewCall(i + 1, c, 10_000);
		});
		expect(reviewCostPer1kContext(db)).toBeCloseTo(0.03, 10);
		addReviewCall(6, 0.6, 10_000);
		expect(reviewCostPer1kContext(db)).toBeCloseTo(0.035, 10);
	});

	it("reviewCostPer1kContext skips calls with no cost or no context and other features", () => {
		[0.1, 0.2, 0.3, 0.4].forEach((c, i) => {
			addReviewCall(i + 1, c, 10_000);
		});
		db.prepare(
			"INSERT INTO self_usage (feature, session_id, input_tokens, cost_usd, ts) VALUES ('review', 'x', 1000, NULL, ?)",
		).run(daysAgo(1));
		db.prepare(
			"INSERT INTO self_usage (feature, session_id, input_tokens, cost_usd, ts) VALUES ('review', 'y', 0, 1, ?)",
		).run(daysAgo(1));
		db.prepare(
			"INSERT INTO self_usage (feature, session_id, input_tokens, cost_usd, ts) VALUES ('summary', 'z', 1000, 1, ?)",
		).run(daysAgo(1));
		expect(reviewCostPer1kContext(db)).toBeNull();
	});

	it("labels goal_drift and review_friction", () => {
		expect(RULE_LABELS.goal_drift).toBe("goal drift");
		expect(RULE_LABELS.review_friction).toBe("friction");
	});
});

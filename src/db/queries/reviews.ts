// The reviews table (feature 08; Phase 5a spec decision 9): one Tier 2 review per session, the weekly footer counters
// and the per-1k-context cost history behind the review estimate.
import type { Db } from "../adapter";

export type ReviewFeedback = "helpful" | "not_helpful";

export type ReviewRowInput = {
	sessionId: string;
	schemaVersion: number;
	result: unknown;
	costUsd: number | null;
	model: string | null;
	createdAt: string;
};

export type ReviewRow = ReviewRowInput & { id: number; feedback: ReviewFeedback | null };

const DAY_MS = 86_400_000;
/** Review calls needed before the estimate switches from the price table to history (feature 08 step 3). */
export const HISTORY_MIN_REVIEWS = 5;

/** Inserts or replaces the session's review (a re-review resets `feedback`); returns the row id, kept on replace. */
export function upsertReview(db: Db, r: ReviewRowInput): number {
	return Number(
		db
			.prepare(
				`INSERT INTO reviews (session_id, schema_version, result, cost_usd, model, created_at, feedback)
				 VALUES (?, ?, ?, ?, ?, ?, NULL)
				 ON CONFLICT (session_id) DO UPDATE SET schema_version = excluded.schema_version, result = excluded.result,
				   cost_usd = excluded.cost_usd, model = excluded.model, created_at = excluded.created_at, feedback = NULL
				 RETURNING id`,
			)
			.get<{ id: number }>(r.sessionId, r.schemaVersion, JSON.stringify(r.result), r.costUsd, r.model, r.createdAt)?.id,
	);
}

type Row = {
	id: number;
	session_id: string;
	schema_version: number;
	result: string;
	cost_usd: number | null;
	model: string | null;
	created_at: string;
	feedback: ReviewFeedback | null;
};

/** The session's review, null when it has none. */
export function getReview(db: Db, sessionId: string): ReviewRow | null {
	const r = db
		.prepare(
			"SELECT id, session_id, schema_version, result, cost_usd, model, created_at, feedback FROM reviews WHERE session_id = ?",
		)
		.get<Row>(sessionId);
	if (!r) return null;
	return {
		id: r.id,
		sessionId: r.session_id,
		schemaVersion: r.schema_version,
		result: JSON.parse(r.result) as unknown,
		costUsd: r.cost_usd,
		model: r.model,
		createdAt: r.created_at,
		feedback: r.feedback,
	};
}

export function setReviewFeedback(db: Db, sessionId: string, value: ReviewFeedback): void {
	db.prepare("UPDATE reviews SET feedback = ? WHERE session_id = ?").run(value, sessionId);
}

/** Reviews stored in the rolling 7 days before `now` and their summed actual cost (unknown costs count 0). */
export function reviewsThisWeek(db: Db, now: Date = new Date()): { count: number; costUsd: number } {
	const r = db
		.prepare("SELECT count(*) AS n, coalesce(sum(cost_usd), 0) AS usd FROM reviews WHERE created_at >= ?")
		.get<{ n: number; usd: number }>(new Date(now.getTime() - 7 * DAY_MS).toISOString());
	return { count: r?.n ?? 0, costUsd: r?.usd ?? 0 };
}

/**
 * Median actual cost per 1k context tokens of past review calls: each `self_usage` review row's `cost_usd` over its
 * own input + cache creation + cache read tokens. Null with fewer than HISTORY_MIN_REVIEWS priced calls. Schema
 * failures count: they paid for the same context.
 */
export function reviewCostPer1kContext(db: Db): number | null {
	const per1k = db
		.prepare(
			`SELECT cost_usd * 1000.0 / (input_tokens + cache_creation_tokens + cache_read_tokens) AS v FROM self_usage
			 WHERE feature = 'review' AND cost_usd IS NOT NULL AND input_tokens + cache_creation_tokens + cache_read_tokens > 0
			 ORDER BY v`,
		)
		.all<{ v: number }>()
		.map((r) => r.v);
	if (per1k.length < HISTORY_MIN_REVIEWS) return null;
	const mid = Math.floor(per1k.length / 2);
	return per1k.length % 2 === 1 ? per1k[mid] : (per1k[mid - 1] + per1k[mid]) / 2;
}

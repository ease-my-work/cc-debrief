// The tracker's own claude -p calls (feature 15): the self_usage ledger, the ai_calls daily-cap ledger, routing of
// internal sessions out of user data, and the aggregates the Overview footer and the Settings table show.
import type { ClaudeResult } from "../../claude/headless";
import type { AiFeature, SelfUsage, SelfUsageLine } from "../../server/types";
import type { Db } from "../adapter";

const FEATURES: AiFeature[] = ["summary", "review", "draft", "recap"];
const DAY_MS = 86_400_000;

/** Stores one finished call's own usage; a second record for the same call session replaces the first. */
export function recordSelfUsage(
	db: Db,
	feature: AiFeature,
	r: ClaudeResult<unknown>,
	targetSessionId?: string,
	now: Date = new Date(),
): void {
	db.prepare(
		`INSERT INTO self_usage (feature, session_id, target_session_id, model, input_tokens, output_tokens,
		 cache_creation_tokens, cache_read_tokens, cost_usd, raw_total_cost_usd, ts)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT (session_id) DO UPDATE SET feature = excluded.feature, target_session_id = excluded.target_session_id,
		   model = excluded.model, input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
		   cache_creation_tokens = excluded.cache_creation_tokens, cache_read_tokens = excluded.cache_read_tokens,
		   cost_usd = excluded.cost_usd, raw_total_cost_usd = excluded.raw_total_cost_usd, ts = excluded.ts`,
	).run(
		feature,
		r.sessionId,
		targetSessionId ?? null,
		r.model ?? null,
		r.usage.inputTokens,
		r.usage.outputTokens,
		r.usage.cacheCreationTokens,
		r.usage.cacheReadTokens,
		r.costUsd,
		r.rawTotalCostUsd,
		now.toISOString(),
	);
}

/** True for the session id of one of the tracker's own calls (the primary routing signal; the sentinel is the fallback). */
export function isInternalSession(db: Db, sessionId: string): boolean {
	return (
		db
			.prepare(
				`SELECT 1 AS x FROM self_usage WHERE session_id = ?
				 UNION ALL SELECT 1 FROM ai_calls WHERE session_id = ? LIMIT 1`,
			)
			.get(sessionId, sessionId) !== undefined
	);
}

// Every table that holds rows for a session id. sessions cascades to its derived tables; events and transcript lines
// have no foreign key to it.
const SESSION_TABLES = [
	"events",
	"transcript_lines",
	"inventory_usage",
	"turns",
	"usage",
	"tool_calls",
	"file_changes",
	"instructions_loaded",
	"subagents",
	"compactions",
	"sessions",
];

/**
 * Removes whatever an internal call's session left in user data (only non-empty when environment inheritance or the
 * sentinel failed) and marks its transcripts internal so ingest never reads them again. Returns the number of
 * internal sessions that had rows removed.
 */
export function cleanupInternalSessions(db: Db): number {
	const ids = db
		.prepare(
			`SELECT session_id AS id FROM self_usage
			 UNION SELECT session_id FROM ai_calls WHERE session_id IS NOT NULL
			 UNION SELECT session_id FROM transcripts WHERE internal = 1 AND agent_id IS NULL`,
		)
		.all<{ id: string }>()
		.map((r) => r.id);
	let cleaned = 0;
	db.transaction(() => {
		const deletes = SESSION_TABLES.map((t) => db.prepare(`DELETE FROM ${t} WHERE session_id = ?`));
		const meta = db.prepare("DELETE FROM meta WHERE key IN ('derive:' || ?, 'skills:' || ?, 'numstat:' || ?)");
		const mark = db.prepare("UPDATE transcripts SET internal = 1 WHERE session_id = ? AND internal = 0");
		for (const id of ids) {
			let changes = 0;
			for (const d of deletes) changes += d.run(id).changes;
			changes += meta.run(id, id, id).changes;
			mark.run(id);
			if (changes > 0) cleaned++;
		}
	});
	return cleaned;
}

/** Percent of user + self USD, 2 decimals; null when there is nothing to divide by. */
function share(part: number, denominator: number): number | null {
	return denominator > 0 ? Math.round((part / denominator) * 10_000) / 100 : null;
}

type FeatureRow = { feature: AiFeature; calls: number; tokens: number; cr: number; usd: number | null };

/** Calls, failures, tokens and USD per feature over a rolling 7 or 30 days, with the share of the user's own USD. */
export function selfUsageSummary(db: Db, range: "7d" | "30d", now: Date = new Date()): SelfUsage {
	const since = new Date(now.getTime() - (range === "7d" ? 7 : 30) * DAY_MS).toISOString();
	const rows = db
		.prepare(
			`SELECT feature, count(*) AS calls,
			   sum(input_tokens + output_tokens + cache_creation_tokens + cache_read_tokens) AS tokens,
			   sum(cache_read_tokens) AS cr, sum(cost_usd) AS usd
			 FROM self_usage WHERE ts >= ? GROUP BY feature`,
		)
		.all<FeatureRow>(since);
	// An attempt that never produced a usage row (crash, timeout, bad output) is a failed call with unknown cost.
	const failedRows = db
		.prepare(
			`SELECT feature, count(*) AS n FROM ai_calls a
			 WHERE ts >= ? AND (session_id IS NULL OR NOT EXISTS (SELECT 1 FROM self_usage s WHERE s.session_id = a.session_id))
			 GROUP BY feature`,
		)
		.all<{ feature: AiFeature; n: number }>(since);
	const userUsd =
		db.prepare("SELECT sum(cost_usd) AS usd FROM usage WHERE ts >= ?").get<{ usd: number | null }>(since)?.usd ?? 0;

	// Every share, per feature too, is of the same total: the user's USD plus everything the tracker spent.
	const denominator = userUsd + rows.reduce((a, r) => a + (r.usd ?? 0), 0);
	const byFeature = FEATURES.map((feature) => {
		const r = rows.find((x) => x.feature === feature);
		const failed = failedRows.find((x) => x.feature === feature)?.n ?? 0;
		const usd = r?.usd ?? 0;
		return {
			feature,
			calls: (r?.calls ?? 0) + failed,
			failed,
			tokens: r?.tokens ?? 0,
			cacheReadTokens: r?.cr ?? 0,
			usd,
			sharePct: share(usd, denominator),
		};
	});
	const sum = (k: "calls" | "failed" | "tokens" | "usd") => byFeature.reduce((a, f) => a + f[k], 0);
	const usd = sum("usd");
	return {
		range,
		byFeature,
		total: {
			calls: sum("calls"),
			failed: sum("failed"),
			tokens: sum("tokens"),
			usd,
			sharePct: share(usd, denominator),
		},
		userUsd,
	};
}

/** The Overview footer's numbers: always the last 7 days across all repos. */
export function selfUsageLine(db: Db, now: Date = new Date()): SelfUsageLine {
	const s = selfUsageSummary(db, "7d", now);
	const calls = (f: AiFeature) => s.byFeature.find((x) => x.feature === f)?.calls ?? 0;
	return {
		summaries: calls("summary"),
		reviews: calls("review"),
		drafts: calls("draft"),
		recaps: calls("recap"),
		tokens: s.total.tokens,
		usd: Math.round(s.total.usd * 100) / 100,
		sharePct: s.total.sharePct,
	};
}

/** Start of the local calendar day of a time (daily caps reset at local midnight). */
export function localDayStart(now: Date): Date {
	return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/** Attempts of a feature since local midnight: the daily-cap count. */
export function aiCallsToday(db: Db, feature: AiFeature, now: Date = new Date()): number {
	const start = localDayStart(now);
	const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
	return (
		db
			.prepare("SELECT count(*) AS n FROM ai_calls WHERE feature = ? AND ts >= ? AND ts < ?")
			.get<{ n: number }>(feature, start.toISOString(), end.toISOString())?.n ?? 0
	);
}

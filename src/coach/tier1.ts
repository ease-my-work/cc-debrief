// Tier 1 runner (feature 07 "When" and "Persist"; Phase 4 spec decision 1): the synchronous signals over one
// loaded context, each in its own try/catch, persisted with keyed upserts.
import type { Db } from "../db/adapter";
import { upsertFindings } from "../db/queries/findings";
import { appendErrorLog } from "../hook/errors";
import { coachErrorsLogPath } from "../paths";
import { loadSessionContext, type SessionShare, sessionCacheShares } from "./context";
import { contextChurn } from "./signals/context-churn";
import { longSession } from "./signals/long-session";
import { mcpBypassed } from "./signals/mcp-bypassed";
import { permissionFriction } from "./signals/permission-friction";
import { retryLoop } from "./signals/retry-loop";
import type { Finding, Signal } from "./types";

/**
 * Bump when a signal's detection, cost or message changes: dashboard start re-checks the last 30 days.
 * 2: skill_unused and discarded_work removed, costs count non-cached tokens (Phase 4 tuning).
 */
export const TIER1_VERSION = 2;

export const SIGNALS: Signal[] = [longSession, mcpBypassed, retryLoop, contextChurn, permissionFriction];
export const SIGNAL_RULES = SIGNALS.map((s) => s.rule);

/** One line in <dataDir>/coach-errors.log (hook-log format and rotation). Never throws. */
export function logCoachError(err: unknown, context: string): void {
	appendErrorLog(coachErrorsLogPath(), err, context);
}

/**
 * Runs every signal over the session, stores the findings (keeping dismissals and feedback) and sets
 * `tier1_version`. A throwing signal is logged and skipped. Returns the number of findings stored.
 */
export function runTier1(
	db: Db,
	sessionId: string,
	opts: { signals?: Signal[]; now?: Date; shares?: SessionShare[] } = {},
): number {
	const signals = opts.signals ?? SIGNALS;
	const ctx = loadSessionContext(db, sessionId, { shares: opts.shares });
	const found: Finding[] = [];
	const ran: string[] = [];
	for (const s of signals) {
		try {
			found.push(...s.detect(ctx));
			ran.push(s.rule);
		} catch (e) {
			logCoachError(e, `${s.rule} ${sessionId}`);
		}
	}
	db.transaction(() => {
		// Only rules that ran replace their rows: a signal that threw keeps what it found last time.
		upsertFindings(db, sessionId, ran, found, opts.now);
		db.prepare("UPDATE sessions SET tier1_version = ? WHERE session_id = ?").run(TIER1_VERSION, sessionId);
	});
	return found.length;
}

/** Sessions active since `since` never checked or checked with an older TIER1_VERSION, newest first. */
export function tier1PendingIds(db: Db, since: Date, limit?: number): string[] {
	return db
		.prepare(
			`SELECT session_id FROM sessions
			 WHERE (tier1_version IS NULL OR tier1_version < ?) AND coalesce(ended_at, started_at) >= ?
			 ORDER BY coalesce(ended_at, started_at) DESC LIMIT ?`,
		)
		.all<{ session_id: string }>(TIER1_VERSION, since.toISOString(), limit ?? -1)
		.map((r) => r.session_id);
}

/**
 * runTier1 for each pending session (tier1PendingIds), up to limit; a session that fails to load is logged and
 * skipped. Returns how many were checked.
 */
export function runTier1Pending(
	db: Db,
	opts: { since: Date; limit?: number; onProgress?: (done: number, total: number) => void },
): number {
	const ids = tier1PendingIds(db, opts.since, opts.limit);
	opts.onProgress?.(0, ids.length);
	// Every cache share from 30 days before the earliest pending start on, read once for all the medians.
	const earliest =
		ids.length > 1
			? db
					.prepare(
						`SELECT min(coalesce(started_at, ended_at)) AS t FROM sessions WHERE session_id IN (${ids.map(() => "?").join(", ")})`,
					)
					.get<{ t: string | null }>(...ids)?.t
			: null;
	const shares = earliest
		? sessionCacheShares(db, new Date(Date.parse(earliest) - 30 * 86_400_000).toISOString(), "9999")
		: undefined;
	let done = 0;
	for (const id of ids) {
		try {
			runTier1(db, id, { shares });
			done++;
		} catch (e) {
			logCoachError(e, `tier1 ${id}`);
		}
		opts.onProgress?.(done, ids.length);
	}
	return done;
}

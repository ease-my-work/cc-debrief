// GET /api/status (feature 12) and the shared "in progress" rule (Phase 2 spec).
import { HOOK_MARKER, readSettingsBytes } from "../../claude/settings";
import { pendingSummaryIds } from "../../collector/summarize";
import { loadConfig } from "../../config";
import { claudeSettingsPath } from "../../paths";
import { getReviewJob, getSummaryJob } from "../../server/jobs";
import { getBackfillProgress, getTier1Progress } from "../../server/progress";
import type { StatusResponse } from "../../server/types";
import { VERSION } from "../../version";
import type { Db } from "../adapter";

export const IN_PROGRESS_MINUTES = 30;

/** ISO time before which a session's last line makes it no longer in progress. */
export const inProgressCutoff = (now: Date): string =>
	new Date(now.getTime() - IN_PROGRESS_MINUTES * 60_000).toISOString();

/**
 * SQL condition for "in progress" over a sessions alias: no SessionEnd event and the last line (sessions.ended_at,
 * the newest transcript line time) at or after the cutoff bound as a parameter.
 */
export const inProgressSql = (alias: string): string =>
	`(${alias}.ended_at >= ? AND NOT EXISTS (SELECT 1 FROM events e WHERE e.session_id = ${alias}.session_id AND e.event = 'SessionEnd'))`;

/** Whether settings.json holds any hook entry of ours. An unreadable file counts as not installed. */
function hooksInstalled(): boolean {
	const bytes = readSettingsBytes(claudeSettingsPath());
	if (!bytes) return false;
	try {
		const hooks = (JSON.parse(bytes.toString("utf8")) as { hooks?: Record<string, unknown> }).hooks;
		if (!hooks || typeof hooks !== "object") return false;
		return Object.values(hooks).some(
			(groups) =>
				Array.isArray(groups) &&
				groups.some(
					(g) =>
						Array.isArray(g?.hooks) &&
						g.hooks.some(
							(x: { command?: unknown }) => typeof x?.command === "string" && x.command.includes(HOOK_MARKER),
						),
				),
		);
	} catch {
		return false;
	}
}

export function getStatus(db: Db, now: Date = new Date()): StatusResponse {
	const cfg = loadConfig();
	const one = <T>(sql: string, ...p: unknown[]) => db.prepare(sql).get<T>(...p);
	return {
		ai: {
			summaries: cfg.ai.summaries.enabled,
			reviews: cfg.ai.review.enabled,
			autoReview: cfg.ai.review.auto,
			drafts: cfg.ai.drafts.enabled,
		},
		lastIngestAt: one<{ t: string | null }>("SELECT max(last_ingested_at) AS t FROM transcripts")?.t ?? null,
		lastHookEventAt: one<{ t: string | null }>("SELECT max(ts) AS t FROM events")?.t ?? null,
		hooksInstalled: hooksInstalled(),
		backfill: getBackfillProgress(),
		summaryJob: getSummaryJob(),
		reviewJob: getReviewJob(),
		tier1Job: getTier1Progress(),
		inProgressSessions:
			one<{ n: number }>(`SELECT count(*) AS n FROM sessions s WHERE ${inProgressSql("s")}`, inProgressCutoff(now))
				?.n ?? 0,
		pollSeconds: cfg.dashboard.pollSeconds,
		pendingSummaries: pendingSummaryIds(db, { capture: "hooks", now }).length,
		pendingImportedSummaries: pendingSummaryIds(db, { capture: "backfill", now }).length,
		version: VERSION,
	};
}

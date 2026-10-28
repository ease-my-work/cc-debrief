// Where detection runs (Phase 5b spec decision 8): at the end of enrichSession() for the session's repo, and on
// dashboard start after the digest rules for every repo with sessions in the last 30 days, then cross-repo, then the
// installed-pattern checks. Never throws: a failure goes to coach-errors.log.
import { logCoachError } from "../coach/tier1";
import type { Db } from "../db/adapter";
import { crossRepoPatterns } from "./crossrepo";
import { detectPatterns, WINDOW_DAYS } from "./detect";

const DAY_MS = 86_400_000;

/** detectPatterns for one session's repo; nothing for a session without one. */
export function detectForSession(db: Db, sessionId: string, now: Date = new Date()): void {
	try {
		const repoId =
			db.prepare("SELECT repo_id FROM sessions WHERE session_id = ?").get<{ repo_id: string | null }>(sessionId)
				?.repo_id ?? null;
		if (repoId) detectPatterns(db, repoId, now);
	} catch (e) {
		logCoachError(e, `patterns ${sessionId}`);
	}
}

/** Every active repo, then cross-repo, then `afterwards` (the installed-pattern checks). Returns repos checked. */
export function runPatternDetection(
	db: Db,
	opts: { now?: Date; signal?: AbortSignal; afterwards?: (db: Db, now: Date) => void } = {},
): number {
	const now = opts.now ?? new Date();
	let repos: string[] = [];
	try {
		repos = db
			.prepare("SELECT DISTINCT repo_id FROM sessions WHERE repo_id IS NOT NULL AND started_at >= ? ORDER BY repo_id")
			.all<{ repo_id: string }>(new Date(now.getTime() - WINDOW_DAYS * DAY_MS).toISOString())
			.map((r) => r.repo_id);
	} catch (e) {
		logCoachError(e, "patterns");
		return 0;
	}
	let done = 0;
	for (const repo of repos) {
		if (opts.signal?.aborted) return done;
		try {
			detectPatterns(db, repo, now);
			done++;
		} catch (e) {
			logCoachError(e, `patterns ${repo}`);
		}
	}
	if (opts.signal?.aborted) return done;
	try {
		crossRepoPatterns(db, now);
	} catch (e) {
		logCoachError(e, "patterns cross-repo");
	}
	try {
		opts.afterwards?.(db, now);
	} catch (e) {
		logCoachError(e, "patterns installed");
	}
	return done;
}

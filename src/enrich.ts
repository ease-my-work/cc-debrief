// The async workers around a session: snapshot at SessionStart, enrich at SessionEnd (and for pending sessions).
// Enrich is git state, Tier 1 coaching signals, then (opts.ai) the AI summary through runClaude(); nothing else here
// calls claude -p.
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { reviewEligibility, reviewSession } from "./coach/review";
import { logCoachError, runTier1 } from "./coach/tier1";
import { headAt, headSha, numstat, type RepoInfo, repoInfo } from "./collector/git";
import { pendingSummaryIds, type SummaryOutcome, summarizeSessionResult } from "./collector/summarize";
import { type Config, loadConfig } from "./config";
import type { Db } from "./db/adapter";
import { setMeta } from "./db/queries/meta";
import { upsertRepo } from "./db/queries/repos";
import { aiCallsToday, isInternalSession } from "./db/queries/selfUsage";
import { scanRepoInto } from "./derive/inventory-usage";
import { deriveSession } from "./derive/session";
import { ingestPendingLocked, ingestSession } from "./ingest/ingest";
import { withSessionLock } from "./locks";
import { detectForSession } from "./patterns/run";

const LOCK_WAIT_MS = 5000;
const NUMSTAT_MAX_AGE_MS = 7 * 86_400_000;
const CATCH_UP_LIMIT = 5;
const CATCH_UP_DAYS = 7;

/**
 * SessionStart: creates the session row if missing and records the repo, branch and HEAD (head_start_source
 * "snapshot"; a resumed session keeps its first head_start), then ingests pending transcripts. A session whose
 * transcript never appears keeps its git state and no lines. Busy lock after 5 s: returns without changes.
 */
export async function snapshotSession(db: Db, sessionId: string, cwd: string): Promise<void> {
	const r = await withSessionLock(sessionId, { waitMs: LOCK_WAIT_MS }, async () => {
		db.prepare("INSERT OR IGNORE INTO sessions (session_id, cwd) VALUES (?, ?)").run(sessionId, cwd);
		const info = await repoInfo(cwd);
		if (!info) return null;
		const repoId = upsertRepo(db, info);
		db.transaction(() => {
			// SET expressions read the row as it was, so the CASE sees the old head_start.
			db.prepare(
				`UPDATE sessions SET repo_id = coalesce(repo_id, ?), branch = coalesce(branch, ?),
				   head_start_source = CASE WHEN head_start IS NULL AND ? IS NOT NULL THEN 'snapshot' ELSE head_start_source END,
				   head_start = coalesce(head_start, ?)
				 WHERE session_id = ?`,
			).run(repoId, info.branch, info.head, info.head, sessionId);
		});
		return { root: info.root, repoId };
	});
	if (r === "busy") return;
	// The repo's inventory as of session start (feature 05); read-only on disk.
	if (r) scanRepoInto(db, r.root, r.repoId);
	await ingestPendingLocked(db);
}

function nearestExistingDir(path: string): string | null {
	let dir = path;
	for (let i = 0; i < 64; i++) {
		if (existsSync(dir)) return dir;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
	return null;
}

type SessionGitRow = {
	cwd: string | null;
	repo_id: string | null;
	branch: string | null;
	head_start: string | null;
	started_at: string | null;
	ended_at: string | null;
	capture: string;
};

/**
 * Git answers that do not change within one enrich run: repoInfo per directory and HEAD per repo root. Bulk enrich
 * (318 backfilled sessions took 360 s on Windows, ~1.1 s each in git spawns) asks once per directory / root.
 */
export type GitCache = { info: Map<string, Promise<RepoInfo | null>>; head: Map<string, Promise<string | null>> };
export const newGitCache = (): GitCache => ({ info: new Map(), head: new Map() });

function cachedRepoInfo(cache: GitCache, dir: string): Promise<RepoInfo | null> {
	let p = cache.info.get(dir);
	if (!p) {
		p = repoInfo(dir);
		cache.info.set(dir, p);
	}
	return p;
}

function cachedHeadSha(cache: GitCache, root: string): Promise<string | null> {
	let p = cache.head.get(root);
	if (!p) {
		p = headSha(root);
		cache.head.set(root, p);
	}
	return p;
}

/** Returns the session's repo, or undefined when nothing was captured for the id. */
async function enrichLocked(
	db: Db,
	sessionId: string,
	cache: GitCache,
): Promise<{ repoId: string | null } | undefined> {
	ingestSession(db, sessionId);
	const s = db
		.prepare(
			"SELECT cwd, repo_id, branch, head_start, started_at, ended_at, capture FROM sessions WHERE session_id = ?",
		)
		.get<SessionGitRow>(sessionId);
	if (!s) return undefined; // nothing captured for this id

	let repoId = s.repo_id;
	let upserted = false;
	const info = s.cwd ? await cachedRepoInfo(cache, s.cwd) : null;
	if (info) {
		const id = upsertRepo(db, info);
		upserted = true;
		if (!repoId) repoId = id;
		db.prepare(
			"UPDATE sessions SET repo_id = coalesce(repo_id, ?), branch = coalesce(branch, ?) WHERE session_id = ?",
		).run(id, info.branch, sessionId);
	}

	// Edits outside every known repo (a second working directory): find their repos, then re-derive to attribute them.
	const unresolved = db
		.prepare("SELECT DISTINCT path FROM file_changes WHERE session_id = ? AND repo_id IS NULL")
		.all<{ path: string }>(sessionId);
	const looked = new Map<string, RepoInfo | null>();
	for (const { path } of unresolved) {
		const dir = nearestExistingDir(dirname(path));
		if (!dir || looked.has(dir)) continue;
		const found = await cachedRepoInfo(cache, dir);
		looked.set(dir, found);
		if (found) {
			upsertRepo(db, found);
			upserted = true;
		}
	}
	if (upserted) deriveSession(db, sessionId, { full: true }); // re-attributes earlier file changes

	const root = repoId
		? (db.prepare("SELECT root_path FROM repos WHERE repo_id = ?").get<{ root_path: string }>(repoId)?.root_path ??
			null)
		: null;
	if (root) {
		let headStart = s.head_start;
		if (!headStart && s.started_at) {
			const at = await headAt(root, s.started_at);
			if (at) {
				headStart = at.sha;
				db.prepare("UPDATE sessions SET head_start = ?, head_start_source = ? WHERE session_id = ?").run(
					at.sha,
					at.source,
					sessionId,
				);
			}
		}
		db.prepare("UPDATE sessions SET head_end = ? WHERE session_id = ?").run(
			await cachedHeadSha(cache, root),
			sessionId,
		);

		// Numstat reconciliation (feature 04 step 7); the working tree no longer reflects an old backfilled session.
		const old =
			s.capture === "backfill" && s.ended_at !== null && Date.now() - Date.parse(s.ended_at) > NUMSTAT_MAX_AGE_MS;
		if (!old && headStart && repoId) {
			const rows = await numstat(root, headStart);
			const insensitive = process.platform === "win32";
			const key = (p: string) => (insensitive ? p.toLowerCase() : p);
			const counts = new Map(rows.map((r) => [key(r.path), r]));
			const paths: Record<string, { added: number; removed: number }> = {};
			const changed = db
				.prepare("SELECT DISTINCT path FROM file_changes WHERE session_id = ? AND repo_id = ?")
				.all<{ path: string }>(sessionId, repoId);
			for (const { path } of changed) {
				const c = counts.get(key(path));
				if (c) paths[path] = { added: c.added, removed: c.removed };
			}
			if (Object.keys(paths).length > 0) {
				setMeta(db, `numstat:${sessionId}`, JSON.stringify({ repoId, paths }));
				deriveSession(db, sessionId, { full: true }); // applies it
			}
		}
	}
	db.prepare("UPDATE sessions SET enriched_at = ? WHERE session_id = ?").run(new Date().toISOString(), sessionId);
	return { repoId };
}

/** Tier 1 (feature 07): after derivation, repo work and inventory usage, before the summary; never fails enrich. */
function tier1(db: Db, sessionId: string): void {
	try {
		runTier1(db, sessionId);
	} catch (e) {
		logCoachError(e, `tier1 ${sessionId}`);
	}
}

export type EnrichOptions = {
	/** Summarize the session with claude -p (within ai.summaries.enabled and the daily cap). */
	ai: boolean;
	/** An explicit request (`enrich <id>`): imported sessions may be summarized. */
	explicit?: boolean;
	/** From the SessionEnd hook: afterwards summarize up to 5 other pending hook-captured sessions (feature 06). */
	catchUp?: boolean;
	config?: Config;
};

/**
 * SessionEnd (and pending sessions): reads the rest of the transcript, then git end state: repo, head_start from
 * the reflog / log when no snapshot recorded it, head_end, numstat reconciliation; sets enriched_at; then, with
 * opts.ai, the summary (under the same session lock, so a second worker sees it done). Idempotent. Returns the summary
 * outcome, null when no summary was attempted (ai off, internal session, busy lock).
 */
export async function enrichSession(
	db: Db,
	sessionId: string,
	opts: EnrichOptions,
	cache: GitCache = newGitCache(),
): Promise<SummaryOutcome | null> {
	// A worker spawned for one of our own calls (environment inheritance missing) leaves it alone.
	if (isInternalSession(db, sessionId)) return null;
	const cfg = opts.ai ? (opts.config ?? loadConfig()) : null;
	let enriched = false;
	const r = await withSessionLock(sessionId, { waitMs: LOCK_WAIT_MS }, async () => {
		const e = await enrichLocked(db, sessionId, cache);
		if (!e) return null;
		enriched = true;
		tier1(db, sessionId);
		// Pure JS over the DB, never throws (Phase 5b spec decision 8).
		detectForSession(db, sessionId);
		return cfg ? summarizeSessionResult(db, sessionId, cfg, { explicit: opts.explicit }) : null;
	});
	// After the session lock: a review holds its own review-<id> lock for up to 180 s.
	if (cfg && enriched) await autoReview(db, sessionId, cfg);
	if (cfg && opts.catchUp) await catchUpSummaries(db, cfg, { exclude: sessionId });
	return r === "busy" ? null : r;
}

/**
 * Feature 08 trigger 2: reviews the session when it is auto-eligible (reviews and auto-review on, ended, crosses a
 * threshold, hook-captured, not reviewed). Never throws; a failed review goes to coach-errors.log. Catch-up runs do not
 * review.
 */
async function autoReview(db: Db, sessionId: string, cfg: Config): Promise<void> {
	if (!cfg.ai.review.enabled || !cfg.ai.review.auto) return;
	try {
		if (!reviewEligibility(db, sessionId, cfg).autoEligible) return;
		const o = await reviewSession(db, sessionId, cfg, { trigger: "auto" });
		if (o.status === "error") logCoachError(new Error(o.reason ?? "review failed"), `review ${sessionId}`);
	} catch (e) {
		logCoachError(e, `review ${sessionId}`);
	}
}

/**
 * Summarizes pending hook-captured sessions from the last 7 days, oldest first, while under the daily cap; busy
 * sessions are skipped. How capped or failed-to-spawn sessions get their summary without a manual `enrich`.
 */
export async function catchUpSummaries(
	db: Db,
	cfg: Config,
	opts: { limit?: number; exclude?: string; now?: Date } = {},
): Promise<number> {
	if (!cfg.ai.summaries.enabled) return 0;
	const now = opts.now ?? new Date();
	const ids = pendingSummaryIds(db, {
		capture: "hooks",
		since: new Date(now.getTime() - CATCH_UP_DAYS * 86_400_000),
		now,
	}).filter((id) => id !== opts.exclude);
	let done = 0;
	for (const id of ids.slice(0, opts.limit ?? CATCH_UP_LIMIT)) {
		if (aiCallsToday(db, "summary", now) >= cfg.ai.maxPerDay) break;
		const r = await withSessionLock(id, { waitMs: 0 }, () => summarizeSessionResult(db, id, cfg));
		if (r !== "busy" && r.status === "done") done++;
	}
	return done;
}

/**
 * Enriches sessions with no enriched_at, oldest first, up to limit (default 100); returns how many were done. One
 * GitCache serves the whole run; an aborted signal stops between sessions.
 */
export async function enrichPending(
	db: Db,
	opts: { ai: boolean; limit?: number; signal?: AbortSignal },
): Promise<number> {
	const cache = newGitCache();
	const ids = db
		.prepare(
			"SELECT session_id FROM sessions WHERE enriched_at IS NULL ORDER BY started_at IS NULL, started_at LIMIT ?",
		)
		.all<{ session_id: string }>(opts.limit ?? 100)
		.map((r) => r.session_id);
	let done = 0;
	for (const id of ids) {
		if (opts.signal?.aborted) break;
		await enrichSession(db, id, { ...opts, catchUp: false }, cache);
		const row = db
			.prepare("SELECT enriched_at FROM sessions WHERE session_id = ?")
			.get<{ enriched_at: string | null }>(id);
		if (row?.enriched_at) done++;
	}
	return done;
}

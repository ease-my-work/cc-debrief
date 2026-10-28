// Work recap queries (feature 17 "Which sessions count as work", "File line"). The SQL returns turn start times in the
// range (through the turns_started_at index); local-day bucketing happens here in JS, at request time.
import { decodePayload } from "../../ingest/line";
import type { Db } from "../adapter";
import { localDate } from "./range";

export type RecapRow = {
	sessionId: string;
	repoId: string | null;
	repoName: string | null;
	rootPath: string | null;
	cwd: string | null;
	title: string | null;
	agentName: string | null;
	summary: string | null;
	/** Local date YYYY-MM-DD. */
	day: string;
	/** Turns started on that day. */
	turns: number;
	firstTurnAt: string;
	/** Start times of that day's turns, oldest first (the view's activity strip). */
	turnTimes: string[];
};

/**
 * Turns in [from, to) of sessions that count as work: ≥ 2 turns overall or ≥ 1 file change. The tracker's own
 * `claude -p` sessions (a self_usage row here; an ai_calls row in recapRows) are left out. Never selects prompt text.
 */
export const RECAP_ROWS_SQL = `
	WITH d AS (
	  SELECT session_id, started_at FROM turns WHERE started_at >= ? AND started_at < ?
	), ids AS (
	  SELECT DISTINCT session_id FROM d
	), ok AS (
	  SELECT i.session_id FROM ids i
	  WHERE ((SELECT count(*) FROM turns x WHERE x.session_id = i.session_id) >= 2
	         OR EXISTS (SELECT 1 FROM file_changes f WHERE f.session_id = i.session_id))
	    AND NOT EXISTS (SELECT 1 FROM self_usage u WHERE u.session_id = i.session_id)
	)
	SELECT d.session_id AS sessionId, d.started_at AS startedAt, s.repo_id AS repoId, r.name AS repoName,
	       r.root_path AS rootPath, s.cwd AS cwd, s.title AS title, s.agent_name AS agentName, s.summary AS summary
	FROM d JOIN ok ON ok.session_id = d.session_id
	JOIN sessions s ON s.session_id = d.session_id
	LEFT JOIN repos r ON r.repo_id = s.repo_id
	ORDER BY d.started_at, d.session_id`;

export type RecapFile = { sessionId: string; day: string; path: string; repoId: string | null; churn: number };

type TurnRow = Omit<RecapRow, "day" | "turns" | "firstTurnAt" | "turnTimes"> & { startedAt: string };

/** One row per session per local day with ≥ 1 turn in [fromIso, toIso), ordered by that day's first turn. */
export function recapRows(db: Db, fromIso: string, toIso: string): RecapRow[] {
	const turns = db.prepare(RECAP_ROWS_SQL).all<TurnRow>(fromIso, toIso);
	// The tracker's own calls with an ai_calls row: ai_calls.session_id has no index, so one pass over ai_calls checks
	// only this range's sessions (a correlated NOT EXISTS scanned the table once per session: 4 s for a week).
	const internal = new Set(
		db
			.prepare("SELECT session_id AS id FROM ai_calls WHERE session_id IN (SELECT value FROM json_each(?))")
			.all<{ id: string }>(JSON.stringify([...new Set(turns.map((t) => t.sessionId))]))
			.map((r) => r.id),
	);
	const out = new Map<string, RecapRow>();
	for (const t of turns) {
		if (internal.has(t.sessionId)) continue;
		const day = localDate(new Date(t.startedAt));
		const key = `${t.sessionId}\u0001${day}`;
		const row = out.get(key);
		if (row) {
			row.turns++;
			row.turnTimes.push(t.startedAt);
		} else {
			const { startedAt, ...rest } = t;
			out.set(key, { ...rest, day, turns: 1, firstTurnAt: startedAt, turnTimes: [startedAt] });
		}
	}
	return [...out.values()].sort((a, b) =>
		a.firstTurnAt === b.firstTurnAt ? a.sessionId.localeCompare(b.sessionId) : a.firstTurnAt < b.firstTurnAt ? -1 : 1,
	);
}

/**
 * Edits of the given sessions whose tool call ran in [fromIso, toIso): churn per session, local day and full path, with
 * the edit's repo (hidden repos drop their files from every bullet).
 */
export function recapFiles(db: Db, sessionIds: string[], fromIso: string, toIso: string): RecapFile[] {
	if (sessionIds.length === 0) return [];
	const rows = db
		.prepare(
			`SELECT f.session_id AS sessionId, c.started_at AS startedAt, f.path AS path, f.repo_id AS repoId,
			        f.lines_added + f.lines_removed AS churn
			 FROM file_changes f JOIN tool_calls c ON c.id = f.tool_call_id
			 WHERE f.session_id IN (SELECT value FROM json_each(?)) AND c.started_at >= ? AND c.started_at < ?
			 ORDER BY c.started_at, f.id`,
		)
		.all<Omit<RecapFile, "day"> & { startedAt: string }>(JSON.stringify(sessionIds), fromIso, toIso);
	const out = new Map<string, RecapFile>();
	for (const r of rows) {
		const day = localDate(new Date(r.startedAt));
		const key = `${r.sessionId}\u0001${day}\u0001${r.path}`;
		const hit = out.get(key);
		if (hit) hit.churn += r.churn;
		else out.set(key, { sessionId: r.sessionId, day, path: r.path, repoId: r.repoId, churn: r.churn });
	}
	return [...out.values()];
}

export type RecapRead = { sessionId: string; day: string; path: string; count: number };

/**
 * Read tool calls of the given sessions in [fromIso, toIso): how often each full path was read, per session and local
 * day, most-read first (ties in first-read order). Feeds the "read a, b +N" bullet of a session that edited nothing.
 */
export function recapReads(db: Db, sessionIds: string[], fromIso: string, toIso: string): RecapRead[] {
	if (sessionIds.length === 0) return [];
	const calls = db
		.prepare(
			`SELECT session_id AS sessionId, started_at AS startedAt, input FROM tool_calls
			 WHERE session_id IN (SELECT value FROM json_each(?)) AND tool_name = 'Read'
			   AND started_at >= ? AND started_at < ? AND input IS NOT NULL
			 ORDER BY started_at, id`,
		)
		.all<{ sessionId: string; startedAt: string; input: Uint8Array }>(JSON.stringify(sessionIds), fromIso, toIso);
	const out = new Map<string, RecapRead>();
	for (const c of calls) {
		let path: unknown;
		try {
			path = (decodePayload(c.input) as { file_path?: unknown } | null)?.file_path;
		} catch {
			continue; // an unreadable input names no file
		}
		if (typeof path !== "string" || !path) continue;
		const day = localDate(new Date(c.startedAt));
		const key = `${c.sessionId}\u0001${day}\u0001${path}`;
		const hit = out.get(key);
		if (hit) hit.count++;
		else out.set(key, { sessionId: c.sessionId, day, path, count: 1 });
	}
	return [...out.values()].sort((a, b) => b.count - a.count);
}

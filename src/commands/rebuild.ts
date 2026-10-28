// `rebuild` (architecture "rebuild" rule, feature 13): re-derives every session from our own stored transcript lines
// and hook events, so it works after Claude Code deleted the transcript files. AI columns and head_* survive because
// deriveSession() upserts the sessions row. Never calls claude -p.
import { existsSync } from "node:fs";
import type { Command } from "commander";
import type { Db } from "../db/adapter";
import { deriveSession, forgetDerive } from "../derive/session";
import { deriveSessions, ingestPending } from "../ingest/ingest";
import { count, stdout, withDb } from "./common";

export type RebuildResult = { sessions: number; lines: number; events: number; missingFiles: number };

type FileRow = { id: number; path: string; session_id: string };

/**
 * --reingest: files still on disk lose their stored lines and offsets and are read again from 0 (after a slimLine()
 * change); files no longer on disk keep their lines.
 */
function resetPresentFiles(db: Db): void {
	const files = db
		.prepare("SELECT id, path, session_id FROM transcripts WHERE internal = 0 AND purged_at IS NULL")
		.all<FileRow>()
		.filter((f) => existsSync(f.path));
	db.transaction(() => {
		const lines = db.prepare("DELETE FROM transcript_lines WHERE file_id = ?");
		const reset = db.prepare(
			`UPDATE transcripts SET bytes_ingested = 0, lines = 0, parse_errors = 0, first_line_uuid = NULL,
			 size = -1, mtime_ms = -1, missing_since = NULL WHERE id = ?`,
		);
		for (const f of files) {
			lines.run(f.id);
			reset.run(f.id);
			forgetDerive(db, f.session_id);
		}
	});
}

export function rebuild(db: Db, opts: { reingest: boolean }): RebuildResult {
	if (opts.reingest) {
		resetPresentFiles(db);
		ingestPending(db, { derive: () => {} }); // the full derive below covers every touched session
	}
	const ids = db
		.prepare(
			`SELECT session_id FROM transcript_lines
			 UNION SELECT session_id FROM events
			 EXCEPT SELECT session_id FROM transcripts WHERE internal = 1 AND agent_id IS NULL`,
		)
		.all<{ session_id: string }>()
		.map((r) => r.session_id);
	// One transaction per session; deriveSessions also settles usage ownership between sessions (rederive queue).
	deriveSessions(db, ids, {
		derive: (d, id) => d.transaction(() => deriveSession(d, id, { full: true })),
	});
	const n = (sql: string) => db.prepare(sql).get<{ n: number }>()?.n ?? 0;
	const missingFiles = db
		.prepare("SELECT path FROM transcripts WHERE internal = 0 AND purged_at IS NULL")
		.all<{ path: string }>()
		.filter((f) => !existsSync(f.path)).length;
	return {
		sessions: ids.length,
		lines: n("SELECT count(*) AS n FROM transcript_lines"),
		events: n("SELECT count(*) AS n FROM events"),
		missingFiles,
	};
}

export function registerRebuildCommand(program: Command): void {
	program
		.command("rebuild")
		.description("re-derive every session from the stored transcript lines and hook events (no AI)")
		.option("--reingest", "first re-read every transcript file still on disk from the start")
		.action(async (opts: { reingest?: boolean }) => {
			await withDb((db) => {
				const r = rebuild(db, { reingest: opts.reingest ?? false });
				const gone =
					r.missingFiles > 0
						? ` · ${count(r.missingFiles, "transcript file")} no longer on disk (rebuilt from stored lines)`
						: "";
				stdout(
					`rebuilt ${count(r.sessions, "session")} from ${count(r.lines, "transcript line")} and ${count(r.events, "hook event")}${gone}`,
				);
			});
		});
}

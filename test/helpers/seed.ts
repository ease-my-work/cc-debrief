import { join } from "node:path";
import { type Db, openDb } from "../../src/db/adapter";
import { migrate } from "../../src/db/migrate";
import { encodePayload, lineColumns } from "../../src/ingest/line";

/** Opens and migrates the DB for env (default: process.env, as set by tmpHome()). */
export function seedDb(env: NodeJS.ProcessEnv = process.env): Db {
	const path = env.CC_DEBRIEF_DB || (env.CC_DEBRIEF_HOME ? join(env.CC_DEBRIEF_HOME, "tracker.db") : undefined);
	const db = openDb(path);
	migrate(db);
	return db;
}

/**
 * Stores lines straight into transcript_lines for a session (as ingest would, minus redaction and slimming),
 * bypassing ingest, which drops sentinel transcripts. A second call for the same session and agent appends to the
 * same file (line numbers continue), like a transcript that grew. Returns the transcripts row id.
 */
export function storeLines(db: Db, sessionId: string, lines: object[], agentId: string | null = null): number {
	const path = `/x/${sessionId}/${agentId ?? "main"}.jsonl`;
	const existing = db.prepare("SELECT id FROM transcripts WHERE path = ?").get<{ id: number }>(path);
	const fileId =
		existing?.id ??
		Number(
			db
				.prepare("INSERT INTO transcripts (path, session_id, agent_id, size, mtime_ms) VALUES (?, ?, ?, 0, 0)")
				.run(path, sessionId, agentId).lastInsertRowid,
		);
	const start =
		(db.prepare("SELECT max(line_no) AS m FROM transcript_lines WHERE file_id = ?").get<{ m: number | null }>(fileId)
			?.m ?? -1) + 1;
	const insert = db.prepare(
		`INSERT INTO transcript_lines (session_id, agent_id, file_id, line_no, uuid, parent_uuid, type, subtype, ts, payload)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	lines.forEach((l, i) => {
		const c = lineColumns(l as Record<string, unknown>);
		insert.run(sessionId, agentId, fileId, start + i, c.uuid, c.parentUuid, c.type, c.subtype, c.ts, encodePayload(l));
	});
	return fileId;
}

// Retention and purge (feature 14): whole sessions older than the cutoff go with every dependent row; their
// transcripts rows stay, marked purged at end of file, so ingest never imports them again.
import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { callTranscriptsDir } from "../../claude/headless";
import type { Config } from "../../config";
import { rawDir } from "../../paths";
import type { Db } from "../adapter";
import { getMeta, setMeta } from "./meta";

const DAY_MS = 86_400_000;
const RUN_EVERY_MS = DAY_MS;
// A session's age is its latest activity: the newest transcript line (ended_at), its start, or its newest hook event.
// Dating by start would delete a session that is resumed for months, and its purged transcript would never be read again.
const LAST_ACTIVITY = `max(coalesce(s.ended_at, ''), coalesce(s.started_at, ''),
  coalesce((SELECT max(e.ts) FROM events e WHERE e.session_id = s.session_id), ''))`;

/** Rows deleted (or that would be) per table, plus the compressed payload bytes of the transcript lines. */
export type PurgeCounts = Record<string, number> & { sessions: number; transcript_lines: number; bytes: number };

// Session-keyed tables, children first. findings and reviews exist from Phases 4 and 5a.
const SESSION_TABLES = [
	"transcript_lines",
	"events",
	"inventory_usage",
	"turns",
	"usage",
	"tool_calls",
	"file_changes",
	"subagents",
	"compactions",
	"instructions_loaded",
	"findings",
	"reviews",
];

function tables(db: Db): Set<string> {
	return new Set(
		db
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
			.all<{ name: string }>()
			.map((r) => r.name),
	);
}

// The run inside a savepoint that a dry run rolls back, so the counts are exactly what a real run deletes.
function inSavepoint<T>(db: Db, dryRun: boolean, fn: () => T): T {
	if (!dryRun) return db.transaction(fn);
	db.exec("SAVEPOINT purge_dry_run");
	try {
		return fn();
	} finally {
		db.exec("ROLLBACK TO purge_dry_run");
		db.exec("RELEASE purge_dry_run");
	}
}

/** Deletes the entries of dir last modified before the cutoff (null = all); files only unless withDirs. */
function purgeOldEntries(dir: string, cutoffMs: number | null, dryRun: boolean, withDirs = false): number {
	let n = 0;
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return 0; // no such dir
	}
	for (const name of names) {
		const path = join(dir, name);
		try {
			const st = statSync(path);
			if (!(st.isFile() || (withDirs && st.isDirectory())) || (cutoffMs !== null && st.mtimeMs >= cutoffMs)) continue;
			if (!dryRun) rmSync(path, { recursive: true, force: true });
			n++;
		} catch {
			// gone meanwhile
		}
	}
	return n;
}

const purgeRawFiles = (cutoffMs: number | null, dryRun: boolean) => purgeOldEntries(rawDir(), cutoffMs, dryRun);

/** Transcripts our own claude -p calls left that runClaude() could not delete (review 2026-10-10). */
const purgeCallTranscripts = (cutoffMs: number | null, dryRun: boolean) =>
	purgeOldEntries(callTranscriptsDir(), cutoffMs, dryRun, true);

/**
 * Deletes sessions whose latest activity (last line, start or newest hook event) is before the cutoff, and
 * every dependent row; old self_usage / ai_calls rows, orphan events, expired dismissals, raw/ dumps and leftover
 * transcripts of the tracker's own calls; keeps repos,
 * inventory, config and drafts. The sessions' transcripts rows get purged_at and an offset at end of file.
 */
export function purgeOlderThan(db: Db, cutoff: Date, opts: { now?: Date; dryRun?: boolean } = {}): PurgeCounts {
	const now = (opts.now ?? new Date()).toISOString();
	const cut = cutoff.toISOString();
	const have = tables(db);
	const counts = inSavepoint(db, opts.dryRun ?? false, () => {
		db.exec("CREATE TEMP TABLE IF NOT EXISTS purge_ids (id TEXT PRIMARY KEY)");
		db.exec("DELETE FROM temp.purge_ids");
		db.prepare(
			`INSERT INTO temp.purge_ids SELECT s.session_id FROM sessions s
			 WHERE ${LAST_ACTIVITY} < ?`,
		).run(cut);
		const c: Record<string, number> = {
			sessions: db.prepare("SELECT count(*) AS n FROM temp.purge_ids").get<{ n: number }>()?.n ?? 0,
			bytes:
				db
					.prepare(
						"SELECT coalesce(sum(length(payload)), 0) AS n FROM transcript_lines WHERE session_id IN (SELECT id FROM temp.purge_ids)",
					)
					.get<{ n: number }>()?.n ?? 0,
		};
		for (const t of SESSION_TABLES) {
			if (!have.has(t)) continue;
			c[t] = db.prepare(`DELETE FROM ${t} WHERE session_id IN (SELECT id FROM temp.purge_ids)`).run().changes;
		}
		db.prepare("DELETE FROM sessions WHERE session_id IN (SELECT id FROM temp.purge_ids)").run();
		db.prepare(
			`UPDATE transcripts SET purged_at = ?, bytes_ingested = max(size, bytes_ingested)
			 WHERE session_id IN (SELECT id FROM temp.purge_ids)`,
		).run(now);
		c.meta = db
			.prepare(
				`DELETE FROM meta WHERE key IN (SELECT p || id FROM temp.purge_ids,
				   (SELECT 'derive:' AS p UNION ALL SELECT 'skills:' UNION ALL SELECT 'numstat:' UNION ALL SELECT 'rederive:'))`,
			)
			.run().changes;
		c.meta += db.prepare("DELETE FROM meta WHERE key LIKE 'dismiss:%' AND value < ?").run(now).changes;
		// Orphans only: a kept session (resumed over months) keeps its old PermissionRequest events (review B10).
		c.events =
			(c.events ?? 0) +
			db.prepare("DELETE FROM events WHERE ts < ? AND session_id NOT IN (SELECT session_id FROM sessions)").run(cut)
				.changes;
		c.self_usage = db.prepare("DELETE FROM self_usage WHERE ts < ?").run(cut).changes;
		c.ai_calls = db.prepare("DELETE FROM ai_calls WHERE ts < ?").run(cut).changes;
		if (have.has("findings")) {
			c.findings =
				(c.findings ?? 0) +
				db.prepare("DELETE FROM findings WHERE session_id IS NULL AND created_at < ?").run(cut).changes;
		}
		db.exec("DELETE FROM temp.purge_ids");
		return c;
	});
	counts.raw_files = purgeRawFiles(cutoff.getTime(), opts.dryRun ?? false);
	counts.call_transcripts = purgeCallTranscripts(cutoff.getTime(), opts.dryRun ?? false);
	return counts as PurgeCounts;
}

/**
 * Deletes every row of every table except meta.schema_version and init.* (so uninit can still restore settings.json),
 * and sets meta.ingest_not_before so transcripts still on disk are not imported again.
 */
export function purgeAll(db: Db, opts: { now?: Date; dryRun?: boolean } = {}): PurgeCounts {
	const now = (opts.now ?? new Date()).toISOString();
	const names = [...tables(db)].filter((t) => t !== "meta");
	const counts = inSavepoint(db, opts.dryRun ?? false, () => {
		const c: Record<string, number> = {
			sessions: db.prepare("SELECT count(*) AS n FROM sessions").get<{ n: number }>()?.n ?? 0,
			bytes:
				db.prepare("SELECT coalesce(sum(length(payload)), 0) AS n FROM transcript_lines").get<{ n: number }>()?.n ?? 0,
		};
		// Children before parents (foreign keys): everything that references sessions or transcripts first.
		const order = [...names].sort((a, b) => rank(a) - rank(b));
		for (const t of order) {
			const changes = db.prepare(`DELETE FROM ${t}`).run().changes;
			if (t !== "sessions") c[t] = changes;
		}
		c.meta = db.prepare("DELETE FROM meta WHERE key <> 'schema_version' AND key NOT LIKE 'init.%'").run().changes;
		setMeta(db, "ingest_not_before", now);
		return c;
	});
	counts.raw_files = purgeRawFiles(null, opts.dryRun ?? false);
	counts.call_transcripts = purgeCallTranscripts(null, opts.dryRun ?? false);
	return counts as PurgeCounts;
}

// Delete order for purgeAll: every child before the table it references. sessions.repo_id references repos (no
// ON DELETE action), inventory_usage references sessions and inventory, transcript_lines references transcripts.
function rank(table: string): number {
	if (table === "repos" || table === "inventory") return 3;
	if (table === "sessions") return 2;
	if (table === "transcripts") return 1;
	return 0;
}

/** Automatic retention: at dashboard start and the end of enrich, at most once per 24 h; never with retention.days 0. */
export function runRetention(db: Db, cfg: Config, now: Date = new Date()): PurgeCounts | "skipped" {
	const days = cfg.retention.days;
	if (days <= 0) return "skipped";
	const last = getMeta(db, "last_retention_run");
	if (last && now.getTime() - Date.parse(last) < RUN_EVERY_MS) return "skipped";
	const counts = purgeOlderThan(db, new Date(now.getTime() - days * DAY_MS), { now });
	setMeta(db, "last_retention_run", now.toISOString());
	return counts;
}

/** Sessions the next retention run would delete with retention.days = days (the Settings preview); 0 keeps all. */
export function retentionPreview(db: Db, days: number, now: Date = new Date()): number {
	if (days <= 0) return 0;
	const cut = new Date(now.getTime() - days * DAY_MS).toISOString();
	return (
		db
			.prepare(
				`SELECT count(*) AS n FROM sessions s
				 WHERE ${LAST_ACTIVITY} < ?`,
			)
			.get<{ n: number }>(cut)?.n ?? 0
	);
}

// Incremental transcript ingest: reads each JSONL file from its stored byte offset to the last complete line,
// redacts, slims and compresses every line into transcript_lines, then re-derives the touched sessions.
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { type Config, loadConfig } from "../config";
import type { Db } from "../db/adapter";
import { getMeta } from "../db/queries/meta";
import { isInternalSession } from "../db/queries/selfUsage";
import { deriveSession, forgetDerive, withFreshPayloads } from "../derive/session";
import { trySessionLockSync, withSessionLock } from "../locks";
import { redactDeep } from "../redact";
import { listTranscripts, type TranscriptFile } from "./files";
import { encodePayload, lineColumns, parseLine, slimLine } from "./line";

export type IngestResult = { files: number; lines: number; parseErrors: number; sessions: string[] };
export type IngestDeps = {
	/** Re-derives a session after its lines changed; defaults to deriveSession(). */
	derive?: (db: Db, sessionId: string) => void;
	now?: () => Date;
	/** Defaults to loadConfig() once per call. */
	config?: Config;
	/** ingest --all: unchanged files (same size and mtime) still get the first-line identity check. */
	recheck?: boolean;
	/**
	 * With a deferred derive (the Stop worker): the files' "done" markers are collected here instead of written, and
	 * the caller writes them with commitFiles() once its derive succeeded (review A1).
	 */
	commits?: FileCommit[];
};

/** A file's size and mtime ("done" marker) and, when lines were read, the time that becomes `last_ingested_at`. */
export type FileCommit = { id: number; size: number; mtimeMs: number; ingestedAt: string | null };

const CHUNK = 1 << 20; // read size and transaction size (bytes of source lines)
const HEAD = 64 * 1024; // how far the identity check looks for the first uuid
const SENTINEL = "[cc-debrief:";
const TS_KEY = '"timestamp":"';

type TranscriptRow = {
	id: number;
	size: number;
	mtime_ms: number;
	bytes_ingested: number;
	first_line_uuid: string | null;
	cwd: string | null;
	lines: number;
	parse_errors: number;
	internal: number;
	purged_at: string | null;
	missing_since: string | null;
};

type Ctx = {
	derive: (db: Db, sessionId: string) => void;
	now: () => Date;
	config: Config;
	notBefore: number | null;
	recheck: boolean;
	commits: FileCommit[] | null;
};

type FileOutcome = {
	processed: boolean;
	changed: boolean;
	lines: number;
	parseErrors: number;
	/** The file's "done" marker, written by run() only after its session is derived. */
	commit?: FileCommit;
};
const SKIPPED: FileOutcome = { processed: false, changed: false, lines: 0, parseErrors: 0 };

function context(db: Db, deps: IngestDeps): Ctx {
	const notBefore = getMeta(db, "ingest_not_before");
	return {
		derive: deps.derive ?? deriveSession,
		now: deps.now ?? (() => new Date()),
		config: deps.config ?? loadConfig(),
		notBefore: notBefore ? Date.parse(notBefore) : null,
		recheck: deps.recheck ?? false,
		commits: deps.commits ?? null,
	};
}

/** Complete lines between start and end (exclusive of a trailing partial line), with each line's end offset. */
function* readLines(fd: number, start: number, end: number): Generator<{ text: string; end: number }> {
	const buf = Buffer.allocUnsafe(CHUNK);
	let carry: Buffer = Buffer.alloc(0);
	let pos = start;
	while (pos < end) {
		const n = readSync(fd, buf, 0, Math.min(CHUNK, end - pos), pos);
		if (n === 0) break;
		const data = carry.length > 0 ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
		const dataStart = pos - carry.length;
		pos += n;
		// Splitting on the 0x0A byte never cuts a UTF-8 sequence.
		let lineStart = 0;
		for (let i = data.indexOf(10); i !== -1; i = data.indexOf(10, lineStart)) {
			yield { text: data.toString("utf8", lineStart, i), end: dataStart + i + 1 };
			lineStart = i + 1;
		}
		carry = Buffer.from(data.subarray(lineStart)); // copy: buf is reused
	}
}

/** uuid of the first line that has one, within the first 64 KiB (the file's identity). */
function headUuid(fd: number, size: number): string | null {
	for (const { text } of readLines(fd, 0, Math.min(size, HEAD))) {
		const p = parseLine(text);
		if (p.ok && typeof p.line.uuid === "string") return p.line.uuid;
	}
	return null;
}

// ingest --all on an unchanged file: has its first line (the file's identity) changed?
function identityChanged(file: TranscriptFile, row: TranscriptRow): boolean {
	if (row.first_line_uuid === null) return false;
	const fd = openSync(file.path, "r");
	try {
		const head = headUuid(fd, statSync(file.path).size);
		return head !== null && head !== row.first_line_uuid;
	} finally {
		closeSync(fd);
	}
}

function isSentinelPrompt(line: Record<string, unknown>): boolean {
	if (line.type !== "user") return false;
	const content = (line.message as { content?: unknown } | undefined)?.content;
	if (typeof content === "string") return content.startsWith(SENTINEL);
	return (
		Array.isArray(content) &&
		content.some((b) => b?.type === "text" && typeof b.text === "string" && b.text.startsWith(SENTINEL))
	);
}

// Cheap first pass over the region to be read: any sentinel prompt, and the last timestamp for the retention
// cutoff. Only lines containing the sentinel text are parsed.
function prescan(
	fd: number,
	start: number,
	end: number,
	wantTs: boolean,
): { sentinel: boolean; lastTs: string | null } {
	let lastTs: string | null = null;
	for (const { text } of readLines(fd, start, end)) {
		if (text.includes(SENTINEL)) {
			const p = parseLine(text);
			if (p.ok && isSentinelPrompt(p.line)) return { sentinel: true, lastTs };
		}
		if (wantTs) {
			const i = text.lastIndexOf(TS_KEY);
			if (i !== -1) {
				const from = i + TS_KEY.length;
				const to = text.indexOf('"', from);
				if (to !== -1) lastTs = text.slice(from, to);
			}
		}
	}
	return { sentinel: false, lastTs };
}

function sessionIsInternal(db: Db, sessionId: string): boolean {
	return (
		db
			.prepare("SELECT 1 AS x FROM transcripts WHERE session_id = ? AND agent_id IS NULL AND internal = 1")
			.get(sessionId) !== undefined
	);
}

// Records a file as internal (never read again); drops anything stored for it before.
function markInternal(
	db: Db,
	file: TranscriptFile,
	row: TranscriptRow | undefined,
	size: number,
	mtimeMs: number,
	now: string,
) {
	db.transaction(() => {
		if (row) {
			db.prepare("DELETE FROM transcript_lines WHERE file_id = ?").run(row.id);
			db.prepare(
				"UPDATE transcripts SET internal = 1, bytes_ingested = ?, size = ?, mtime_ms = ?, last_ingested_at = ? WHERE id = ?",
			).run(size, size, mtimeMs, now, row.id);
		} else {
			db.prepare(
				`INSERT INTO transcripts (path, session_id, agent_id, size, mtime_ms, bytes_ingested, internal, first_ingested_at, last_ingested_at)
				 VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
			).run(file.path, file.sessionId, file.agentId, size, mtimeMs, size, now, now);
		}
	});
}

function ingestOne(
	db: Db,
	file: TranscriptFile,
	ctx: Ctx,
	payloads: Map<number, Record<string, unknown>>,
): FileOutcome {
	const row = db.prepare("SELECT * FROM transcripts WHERE path = ?").get<TranscriptRow>(file.path);
	if (row && (row.internal || row.purged_at)) return SKIPPED;
	const now = ctx.now().toISOString();

	let st: { size: number; mtimeMs: number };
	try {
		st = statSync(file.path);
	} catch {
		if (row && !row.missing_since) db.prepare("UPDATE transcripts SET missing_since = ? WHERE id = ?").run(now, row.id);
		return SKIPPED;
	}
	if (ctx.notBefore !== null && st.mtimeMs < ctx.notBefore) return SKIPPED;
	if (row && row.size === st.size && row.mtime_ms === st.mtimeMs && !(ctx.recheck && identityChanged(file, row))) {
		return SKIPPED;
	}

	if (file.agentId !== null && sessionIsInternal(db, file.sessionId)) {
		markInternal(db, file, row, st.size, st.mtimeMs, now);
		return { ...SKIPPED, processed: true };
	}
	// The id of one of our own calls (ai_calls / self_usage): the primary signal, needs no sentinel.
	if (isInternalSession(db, file.sessionId)) {
		markInternal(db, file, row, st.size, st.mtimeMs, now);
		return { processed: true, changed: row !== undefined && file.agentId === null, lines: 0, parseErrors: 0 };
	}

	const fd = openSync(file.path, "r");
	try {
		let offset = row?.bytes_ingested ?? 0;
		let reset = false;
		if (row) {
			const head = headUuid(fd, st.size);
			const rewritten = head !== null && row.first_line_uuid !== null && head !== row.first_line_uuid;
			if (st.size < row.bytes_ingested || rewritten) {
				offset = 0;
				reset = true;
			}
		}

		const scan = prescan(fd, offset, st.size, !row);
		if (scan.sentinel && file.agentId === null) {
			markInternal(db, file, row, st.size, st.mtimeMs, now);
			// A known file's session had rows derived from it; re-derive so they go.
			return { processed: true, changed: row !== undefined, lines: 0, parseErrors: 0 };
		}
		const days = ctx.config.retention.days;
		if (!row && days > 0 && scan.lastTs !== null && Date.parse(scan.lastTs) < ctx.now().getTime() - days * 86_400_000) {
			return SKIPPED; // backfill cutoff: never ingested, so no row
		}

		let fileId: number;
		let lines = reset ? 0 : (row?.lines ?? 0);
		let parseErrors = reset ? 0 : (row?.parse_errors ?? 0);
		let firstUuid = reset ? null : (row?.first_line_uuid ?? null);
		// slimLine() drops cwd from every stored line; the file keeps the first one.
		let cwd = reset ? null : (row?.cwd ?? null);
		if (row) {
			fileId = row.id;
			if (reset) {
				db.prepare("DELETE FROM transcript_lines WHERE file_id = ?").run(fileId);
				forgetDerive(db, file.sessionId); // the append state assumes stored lines are never removed
			}
		} else {
			// size / mtime stay -1 until the file is read and its session derived, so an interrupted ingest is never
			// taken as done.
			fileId = Number(
				db
					.prepare(
						`INSERT INTO transcripts (path, session_id, agent_id, size, mtime_ms, first_ingested_at)
						 VALUES (?, ?, ?, -1, -1, ?)`,
					)
					.run(file.path, file.sessionId, file.agentId, now).lastInsertRowid,
			);
		}

		const insert = db.prepare(
			`INSERT OR IGNORE INTO transcript_lines
			 (session_id, agent_id, file_id, line_no, uuid, parent_uuid, type, subtype, ts, payload)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		const update = db.prepare(
			`UPDATE transcripts SET bytes_ingested = ?, lines = ?, parse_errors = ?, first_line_uuid = ?, cwd = ?,
			 missing_since = NULL, size = -1, mtime_ms = -1
			 WHERE id = ?`,
		);
		const { redact, maxFieldBytes } = ctx.config.capture;
		let batch: { params: unknown[]; slim: Record<string, unknown> }[] = [];
		let batchBytes = 0;
		let newLines = 0;
		let newErrors = 0;
		// A row marked -1 by an earlier run that stopped before its derive still needs one.
		const pending = row?.size === -1;
		const flush = () => {
			db.transaction(() => {
				for (const { params, slim } of batch) {
					const res = insert.run(...params);
					if (res.changes > 0) payloads.set(Number(res.lastInsertRowid), slim);
				}
				update.run(offset, lines, parseErrors, firstUuid, cwd, fileId);
			});
			batch = [];
			batchBytes = 0;
		};

		for (const { text, end } of readLines(fd, offset, st.size)) {
			const lineNo = lines++;
			newLines++;
			offset = end;
			const parsed = parseLine(text);
			if (!parsed.ok) {
				parseErrors++;
				newErrors++;
				continue;
			}
			const cols = lineColumns(parsed.line);
			if (firstUuid === null && cols.uuid !== null) firstUuid = cols.uuid;
			if (cwd === null && typeof parsed.line.cwd === "string") cwd = parsed.line.cwd;
			if (parsed.line.type === "file-history-snapshot") continue; // slimLine() drops it; skip redacting it
			// Redact (and cap) before slimming, so slimLine()'s 8 KB / 1 KB cuts never leave part of a secret.
			const slim = slimLine(redactDeep(parsed.line, redact, maxFieldBytes));
			if (slim === null) continue;
			batch.push({
				params: [
					file.sessionId,
					file.agentId,
					fileId,
					lineNo,
					cols.uuid,
					cols.parentUuid,
					cols.type,
					cols.subtype,
					cols.ts,
					encodePayload(slim),
				],
				slim,
			});
			batchBytes += text.length;
			if (batchBytes >= CHUNK) flush();
		}
		flush();
		return {
			processed: true,
			changed: newLines > 0 || reset || pending,
			lines: newLines,
			parseErrors: newErrors,
			// last_ingested_at is the UI's refresh signal (/api/status lastIngestAt): set with the done marker, after the
			// derive, so a poll never refetches before the new turn is there (review A2).
			commit: { id: fileId, size: st.size, mtimeMs: st.mtimeMs, ingestedAt: newLines > 0 || reset ? now : null },
		};
	} finally {
		closeSync(fd);
	}
}

// Sessions whose usage keys an earlier session took over (meta rederive:<id>, set by deriveSession). Ownership only
// moves to earlier sessions, so this settles; the bound guards against a bug looping forever. Each is derived under
// its own session lock: a live session's Stop worker may be appending to it (review A4). A busy one keeps its key for
// the lock holder's own drain or the next run.
function drainRederive(db: Db, ctx: Ctx, result: IngestResult): void {
	const pending = db.prepare("SELECT key FROM meta WHERE key LIKE 'rederive:%' ORDER BY key");
	const done = db.prepare("DELETE FROM meta WHERE key = ?");
	const busy = new Set<string>();
	for (let round = 0; round < 100; round++) {
		const keys = pending
			.all<{ key: string }>()
			.map((r) => r.key)
			.filter((k) => !busy.has(k));
		if (keys.length === 0) return;
		for (const key of keys) {
			const sessionId = key.slice("rederive:".length);
			const release = SESSION_ID.test(sessionId) ? trySessionLockSync(sessionId) : () => {};
			if (release === null) {
				busy.add(key);
				continue;
			}
			try {
				done.run(key);
				forgetDerive(db, sessionId); // ownership moved under it: rebuild in full, not from the append state
				ctx.derive(db, sessionId);
			} finally {
				release();
			}
			if (!result.sessions.includes(sessionId)) result.sessions.push(sessionId);
		}
	}
}

const SESSION_ID = /^[A-Za-z0-9-]{1,100}$/;

function run(db: Db, files: TranscriptFile[], ctx: Ctx): IngestResult {
	const result: IngestResult = { files: 0, lines: 0, parseErrors: 0, sessions: [] };
	// One session at a time, derived as soon as its files are read, with the payloads just stored (memory stays
	// bounded by one session). Main transcript first, so a subagent file sees whether its session is internal.
	const bySession = new Map<string, TranscriptFile[]>();
	for (const f of files) bySession.set(f.sessionId, [...(bySession.get(f.sessionId) ?? []), f]);
	for (const [sessionId, group] of bySession) {
		const payloads = new Map<number, Record<string, unknown>>();
		const commits: FileCommit[] = [];
		let changed = false;
		for (const file of group.sort((a, b) => Number(a.agentId !== null) - Number(b.agentId !== null))) {
			const o = ingestOne(db, file, ctx, payloads);
			if (o.processed) result.files++;
			result.lines += o.lines;
			result.parseErrors += o.parseErrors;
			if (o.changed) changed = true;
			if (o.commit) commits.push(o.commit);
		}
		if (changed) {
			withFreshPayloads(payloads, () => ctx.derive(db, sessionId));
			result.sessions.push(sessionId);
		}
		// Only now is the session's read complete: a run stopped before this point reads and derives it again. A
		// deferred derive has not run yet, so its caller commits after it.
		if (ctx.commits) ctx.commits.push(...commits);
		else commitFiles(db, commits);
	}
	drainRederive(db, ctx, result);
	return result;
}

/** Writes files' "done" markers (size, mtime) and, for files with new lines, last_ingested_at. */
export function commitFiles(db: Db, commits: FileCommit[]): void {
	const done = db.prepare(
		"UPDATE transcripts SET size = ?, mtime_ms = ?, last_ingested_at = coalesce(?, last_ingested_at) WHERE id = ?",
	);
	db.transaction(() => {
		for (const c of commits) done.run(c.size, c.mtimeMs, c.ingestedAt, c.id);
	});
}

/** Ingests one file and derives its session if anything changed. */
export function ingestFile(db: Db, file: TranscriptFile, deps: IngestDeps = {}): IngestResult {
	return run(db, [file], context(db, deps));
}

/** Ingests a session's main and subagent files, then derives it once. */
export function ingestSession(db: Db, sessionId: string, deps: IngestDeps = {}): IngestResult {
	return run(
		db,
		listTranscripts().filter((f) => f.sessionId === sessionId),
		context(db, deps),
	);
}

/**
 * Ingests every transcript whose size or mtime changed (only files modified since `since`, when given) and
 * derives each touched session once. A full run also marks rows whose file is gone (`missing_since`).
 */
export function ingestPending(db: Db, opts: IngestDeps & { since?: Date } = {}): IngestResult {
	const ctx = context(db, opts);
	const files = listTranscripts({ since: opts.since });
	const result = run(db, files, ctx);
	if (!opts.since) markMissingFiles(db, new Set(files.map((f) => f.path)), ctx.now());
	return result;
}

/** Transcript files new or changed since the last read (not internal, not purged), grouped by session. */
export function pendingGroups(
	db: Db,
	opts: { since?: Date; recheck?: boolean; config?: Config; now?: () => Date } = {},
): { files: TranscriptFile[]; bySession: Map<string, TranscriptFile[]> } {
	const files = listTranscripts({ since: opts.since });
	// A never-read file last written before the retention window holds only lines older than it, which the backfill
	// cutoff skips without a row: leave it out instead of re-reading it on every poll (review A3). Appending to it
	// (a resumed session) moves its mtime back into the window.
	const days = (opts.config ?? loadConfig()).retention.days;
	const cutoff = days > 0 ? (opts.now?.() ?? new Date()).getTime() - days * 86_400_000 : null;
	const known = new Map(
		db
			.prepare("SELECT path, size, mtime_ms, internal, purged_at FROM transcripts")
			.all<{ path: string; size: number; mtime_ms: number; internal: number; purged_at: string | null }>()
			.map((r) => [r.path, r]),
	);
	const bySession = new Map<string, TranscriptFile[]>();
	for (const f of files) {
		const r = known.get(f.path);
		const unchanged = !opts.recheck && r?.size === f.size && r?.mtime_ms === f.mtimeMs;
		if (r && (r.internal || r.purged_at || unchanged)) continue;
		if (!r && cutoff !== null && f.mtimeMs < cutoff) continue;
		bySession.set(f.sessionId, [...(bySession.get(f.sessionId) ?? []), f]);
	}
	return { files, bySession };
}

/**
 * ingestPending() for the async workers (snapshot, dashboard poll, the ingest command): only sessions with a new
 * or changed file are touched, each under its session lock with waitMs 0; busy sessions are skipped, since their
 * lock holder or the next trigger reads the new lines. onProgress(done, total) runs after each session; an aborted
 * signal stops between sessions (dashboard shutdown).
 */
export async function ingestPendingLocked(
	db: Db,
	opts: IngestDeps & { since?: Date; onProgress?: (done: number, total: number) => void; signal?: AbortSignal } = {},
): Promise<IngestResult> {
	const { files, bySession } = pendingGroups(db, opts);
	const total: IngestResult = { files: 0, lines: 0, parseErrors: 0, sessions: [] };
	let done = 0;
	for (const [sessionId, group] of bySession) {
		if (opts.signal?.aborted) break;
		const r = await withSessionLock(sessionId, { waitMs: 0 }, async () => ingestFiles(db, group, opts));
		opts.onProgress?.(++done, bySession.size);
		// ingestFiles is synchronous and an uncontended lock resolves in microtasks: yield a macrotask so a server
		// sharing this process (dashboard) answers requests and signals between sessions.
		await new Promise<void>((resolve) => setImmediate(resolve));
		if (r === "busy") continue;
		total.files += r.files;
		total.lines += r.lines;
		total.parseErrors += r.parseErrors;
		for (const s of r.sessions) if (!total.sessions.includes(s)) total.sessions.push(s);
	}
	if (!opts.since && !opts.signal?.aborted) {
		markMissingFiles(db, new Set(files.map((f) => f.path)), (opts.now ?? (() => new Date()))());
	}
	return total;
}

/** Ingests the given files (the async workers lock each session group around this), one derive per session. */
export function ingestFiles(db: Db, files: TranscriptFile[], deps: IngestDeps = {}): IngestResult {
	return run(db, files, context(db, deps));
}

/** Derives each session once and drains the rederive queue (for callers that ingested with a deferred derive). */
export function deriveSessions(db: Db, sessionIds: Iterable<string>, deps: IngestDeps = {}): void {
	const ctx = context(db, deps);
	const result: IngestResult = { files: 0, lines: 0, parseErrors: 0, sessions: [] };
	for (const id of new Set(sessionIds)) {
		ctx.derive(db, id);
		result.sessions.push(id);
	}
	drainRederive(db, ctx, result);
}

/** Sets missing_since on rows whose file was not listed and is gone from disk; returns how many. */
export function markMissingFiles(db: Db, listedPaths: Set<string>, now: Date = new Date()): number {
	const rows = db
		.prepare("SELECT id, path FROM transcripts WHERE missing_since IS NULL AND purged_at IS NULL")
		.all<{ id: number; path: string }>();
	const mark = db.prepare("UPDATE transcripts SET missing_since = ? WHERE id = ?");
	let n = 0;
	for (const r of rows) {
		if (!listedPaths.has(r.path) && !existsSync(r.path)) {
			mark.run(now.toISOString(), r.id);
			n++;
		}
	}
	return n;
}

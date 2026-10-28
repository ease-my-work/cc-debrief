import { type Command, Option } from "commander";
import type { Db } from "../db/adapter";
import { expectHash } from "../hook/run";
import { listTranscripts } from "../ingest/files";
import {
	commitFiles,
	deriveSessions,
	type FileCommit,
	type IngestResult,
	ingestFiles,
	ingestPendingLocked,
	ingestSession,
} from "../ingest/ingest";
import { decodePayload } from "../ingest/line";
import { withSessionLock } from "../locks";
import { checkSessionId, count, parseDate, quietly, stdout, withDb } from "./common";

const HOOK_DELAY_MS = 500; // Phase 0 B5: CLI transcripts lag Stop by up to 427 ms
const REPLY_WINDOW = 200; // stored main-transcript lines searched for the reply, newest first

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function texts(payload: unknown): string[] {
	const content = isObj(payload) && isObj(payload.message) ? payload.message.content : undefined;
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];
	return content.flatMap((b) => (isObj(b) && b.type === "text" && typeof b.text === "string" ? [b.text] : []));
}

/**
 * Whether the Stop payload's reply (hashed with expectHash) is stored: any text block of the session's recent
 * main-transcript assistant lines, or the text of a run of consecutive assistant lines (a reply split in blocks).
 */
export function replyIngested(db: Db, sessionId: string, hash: string): boolean {
	const rows = db
		.prepare(
			`SELECT type, payload FROM transcript_lines WHERE session_id = ? AND agent_id IS NULL ORDER BY id DESC LIMIT ?`,
		)
		.all<{ type: string; payload: Uint8Array }>(sessionId, REPLY_WINDOW)
		.reverse();
	let run: string[] = [];
	for (const r of rows) {
		if (r.type !== "assistant") {
			run = [];
			continue;
		}
		const t = texts(decodePayload(r.payload));
		if (t.some((x) => expectHash(x) === hash)) return true;
		run.push(...t);
		if (t.length > 0 && run.length > t.length && expectHash(run.join("\n")) === hash) return true;
	}
	return false;
}

export type IngestFromHookDeps = {
	sleep?: (ms: number) => Promise<void>;
	derive?: (db: Db, sessionId: string) => void;
};

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The Stop worker (architecture hook rule 10): wait, take the session lock without waiting, read the session's
 * files; with `expect`, read once more after another wait when the reply is not stored yet; derive once.
 */
export async function ingestFromHook(
	db: Db,
	sessionId: string,
	opts: { expect?: string; delayMs?: number },
	deps: IngestFromHookDeps = {},
): Promise<IngestResult | "busy"> {
	const sleep = deps.sleep ?? wait;
	const delay = opts.delayMs ?? HOOK_DELAY_MS;
	await sleep(delay);
	return withSessionLock(sessionId, { waitMs: 0 }, async () => {
		const touched = new Set<string>();
		// Done markers wait for the derive: if it throws or the worker dies, the files still read as pending (review A1).
		const commits: FileCommit[] = [];
		const deferred = { derive: (_db: Db, id: string) => void touched.add(id), commits };
		const read = () =>
			ingestFiles(
				db,
				listTranscripts().filter((f) => f.sessionId === sessionId),
				deferred,
			);
		const total = read();
		if (opts.expect && !replyIngested(db, sessionId, opts.expect)) {
			await sleep(delay);
			const again = read();
			total.files += again.files;
			total.lines += again.lines;
			total.parseErrors += again.parseErrors;
		}
		deriveSessions(db, touched, { derive: deps.derive });
		commitFiles(db, commits);
		total.sessions = [...touched];
		return total;
	});
}

const summary = (r: IngestResult) =>
	`ingested ${count(r.files, "transcript")} (${count(r.sessions.length, "session")}) · ${count(r.lines, "line")} · ${count(r.parseErrors, "parse error")}`;

export function registerIngestCommand(program: Command): void {
	program
		.command("ingest")
		.description("read new transcript lines into the database (all changed transcripts, or one session)")
		.argument("[session_id]", "only this session's main and subagent transcripts")
		.option("--since <date>", "only transcripts modified after this date", parseDate)
		.option("--all", "also re-check every transcript's first-line identity")
		.addOption(new Option("--from-hook", "run quietly as the Stop hook's worker").hideHelp())
		.addOption(new Option("--expect <hash>", "hash of the reply the Stop hook saw").hideHelp())
		.action(
			async (
				id: string | undefined,
				opts: { since?: Date; all?: boolean; fromHook?: boolean; expect?: string },
				cmd: Command,
			) => {
				if (opts.fromHook) {
					await quietly("ingest", true, async () => {
						if (!id) throw new Error("--from-hook needs a session id");
						const sessionId = checkSessionId(id);
						await withDb((db) => ingestFromHook(db, sessionId, { expect: opts.expect }));
					});
					return;
				}
				if (opts.expect) cmd.error("error: --expect is only used with --from-hook", { exitCode: 2 });
				const recheck = opts.all === true;
				await withDb(async (db) => {
					if (id) {
						const sessionId = checkSessionId(id);
						const r = await withSessionLock(sessionId, { waitMs: 5000 }, async () =>
							ingestSession(db, sessionId, { recheck }),
						);
						if (r === "busy")
							throw new Error(`session ${sessionId} is busy (another cc-debrief process holds its lock)`);
						stdout(summary(r));
					} else {
						stdout(summary(await ingestPendingLocked(db, { since: opts.since, recheck })));
					}
				});
			},
		);
}

// Kept lines for draft context (Phase 5b spec decision 1): the lines a session added that reached a commit, so a draft
// learns from the work that stayed and not from what was thrown away. The rules are the removed Phase 4 discarded-work
// check's (git 30c8b75^): added lines from the edit call's structuredPatch `+` lines, else from its input; trimmed;
// lines under 4 non-whitespace characters ignored; kept = among the `+` lines of `git log --all --since=<started_at> -p
// -- <paths>`. Without git (or the repo gone), every added line is returned with verified false.
import { existsSync } from "node:fs";
import { addedLinesSince } from "../collector/git";
import type { Db } from "../db/adapter";
import { decodePayload } from "../ingest/line";

const MIN_NON_BLANK = 4;
const TRUNCATED = /…\[truncated \d+ bytes\]/;

export type KeptLines = { lines: { path: string; text: string }[]; verified: boolean };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const decode = (blob: Uint8Array | null): Record<string, unknown> => {
	if (!blob) return {};
	try {
		const v = decodePayload(blob);
		return isObj(v) ? v : {};
	} catch {
		return {};
	}
};
const split = (v: unknown): string[] => (typeof v === "string" ? v.split(/\r?\n/) : []);

/** Lines an edit call added: structuredPatch `+` lines, else from the input. */
export function addedLines(
	toolName: string,
	input: Record<string, unknown>,
	response: Record<string, unknown>,
): string[] {
	const result = isObj(response.toolUseResult) ? response.toolUseResult : {};
	if (Array.isArray(result.structuredPatch) && result.structuredPatch.length > 0) {
		const out: string[] = [];
		for (const hunk of result.structuredPatch) {
			if (!isObj(hunk) || !Array.isArray(hunk.lines)) continue;
			for (const l of hunk.lines) if (typeof l === "string" && l.startsWith("+")) out.push(l.slice(1));
		}
		return out;
	}
	const fromPair = (oldText: unknown, newText: unknown) => {
		const old = new Set(split(oldText).map((l) => l.trim()));
		return split(newText).filter((l) => !old.has(l.trim()));
	};
	if (toolName === "Write") return split(input.content);
	if (toolName === "Edit") return fromPair(input.old_string, input.new_string);
	if (toolName === "MultiEdit" && Array.isArray(input.edits)) {
		return input.edits.flatMap((e) => (isObj(e) ? fromPair(e.old_string, e.new_string) : []));
	}
	if (toolName === "NotebookEdit") return split(input.new_source);
	return [];
}

type SessionFacts = { root: string | null; startedAt: string | null; repoId: string | null };

function facts(db: Db, sessionId: string): SessionFacts {
	const r = db
		.prepare(
			`SELECT s.repo_id, s.started_at, r.root_path FROM sessions s LEFT JOIN repos r ON r.repo_id = s.repo_id
			 WHERE s.session_id = ?`,
		)
		.get<{ repo_id: string | null; started_at: string | null; root_path: string | null }>(sessionId);
	return { root: r?.root_path ?? null, startedAt: r?.started_at ?? null, repoId: r?.repo_id ?? null };
}

/** The session's added lines per repo path (trimmed, ≥ 4 non-whitespace characters, distinct per path), unverified. */
export function sessionAddedLines(db: Db, sessionId: string): { path: string; text: string }[] {
	const { repoId } = facts(db, sessionId);
	const changes = db
		.prepare(
			`SELECT f.path, c.tool_name, c.input, c.response FROM file_changes f JOIN tool_calls c ON c.id = f.tool_call_id
			 WHERE f.session_id = ? AND f.repo_id IS ? ORDER BY c.started_at, c.id`,
		)
		.all<{ path: string; tool_name: string; input: Uint8Array | null; response: Uint8Array | null }>(sessionId, repoId);
	const seen = new Set<string>();
	const out: { path: string; text: string }[] = [];
	for (const c of changes) {
		for (const raw of addedLines(c.tool_name, decode(c.input), decode(c.response))) {
			if (TRUNCATED.test(raw)) continue;
			const text = raw.trim();
			if (text.replace(/\s+/g, "").length < MIN_NON_BLANK) continue;
			const key = `${c.path}\n${text}`;
			if (seen.has(key)) continue;
			seen.add(key);
			out.push({ path: c.path, text });
		}
	}
	return out;
}

/** The session's added lines that reached a commit (verified), or all of them unverified when git cannot tell. */
export async function keptAddedLines(db: Db, sessionId: string): Promise<KeptLines> {
	const added = sessionAddedLines(db, sessionId);
	const { root, startedAt } = facts(db, sessionId);
	if (added.length === 0) return { lines: [], verified: true };
	if (!root || !startedAt || !existsSync(root)) return { lines: added, verified: false };
	const kept = await addedLinesSince(root, startedAt, [...new Set(added.map((l) => l.path))]);
	if (kept === null) return { lines: added, verified: false };
	return { lines: added.filter((l) => kept.has(l.text)), verified: true };
}

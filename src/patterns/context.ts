// Draft context (feature 11 "Draft flow" step 3; Phase 5b plan Task 6): per matched session, newest first, its summary,
// first prompt, tool skeleton and kept lines grouped by file, capped at 60,000 characters by dropping the oldest
// sessions. runClaude() adds the `[cc-debrief:draft]` sentinel line.
import { existsSync, readFileSync } from "node:fs";
import { frontMatter } from "../collector/inventory";
import type { Db } from "../db/adapter";
import { getPattern, type Pattern } from "../db/queries/patterns";
import { decodePayload } from "../ingest/line";
import { fingerprintText, toolSkeleton } from "./fingerprint";
import { type KeptLines, keptAddedLines, sessionAddedLines } from "./kept-lines";

export type DraftMode = "create" | "widen" | "rewrite_rule";
export const DRAFT_CONTEXT_MAX = 60_000;
const PROMPT_MAX = 600;
const LINES_PER_FILE = 40;

export type DraftContext = { prompt: string; sessions: string[]; chars: number; unverified: boolean };

export class UnknownPatternError extends Error {
	constructor(id: number) {
		super(`no pattern ${id}`);
	}
}

type SessionInfo = { id: string; startedAt: string; summary: string | null; firstPrompt: string; skeleton: string };

function sessionInfo(db: Db, ids: string[]): SessionInfo[] {
	if (ids.length === 0) return [];
	const marks = ids.map(() => "?").join(", ");
	const rows = db
		.prepare(
			`SELECT s.session_id, s.started_at, CASE WHEN s.type_source = 'ai' THEN s.summary END AS summary,
			   (SELECT t.user_text FROM turns t WHERE t.session_id = s.session_id ORDER BY t.seq LIMIT 1) AS first_prompt
			 FROM sessions s WHERE s.session_id IN (${marks}) ORDER BY s.started_at DESC, s.session_id DESC`,
		)
		.all<{ session_id: string; started_at: string; summary: string | null; first_prompt: string | null }>(...ids);
	return rows.map((r) => {
		const calls = db
			.prepare(
				`SELECT tool_name, mcp_server, input FROM tool_calls WHERE session_id = ? AND agent_id IS NULL
				 ORDER BY started_at, id`,
			)
			.all<{ tool_name: string; mcp_server: string | null; input: Uint8Array | null }>(r.session_id)
			.map((c) => {
				let input: unknown = {};
				try {
					input = c.input ? decodePayload(c.input) : {};
				} catch {
					input = {};
				}
				return { tool_name: c.tool_name, mcp_server: c.mcp_server, input };
			});
		return {
			id: r.session_id,
			startedAt: r.started_at,
			summary: r.summary,
			firstPrompt: (r.first_prompt ?? "").trim().slice(0, PROMPT_MAX),
			skeleton: fingerprintText(toolSkeleton(calls)),
		};
	});
}

function sessionBlock(s: SessionInfo, kept: KeptLines): string {
	const lines = [`### Session ${s.startedAt.slice(0, 10)}`, `First prompt: ${s.firstPrompt || "(none)"}`];
	if (s.summary) lines.push(`Summary: ${s.summary}`);
	if (s.skeleton) lines.push(`Tools: ${s.skeleton}`);
	if (kept.lines.length > 0) {
		lines.push(
			kept.verified ? "Kept lines (committed):" : "Kept lines (unverified: git could not tell what was kept):",
		);
		const byFile = new Map<string, string[]>();
		for (const l of kept.lines) byFile.set(l.path, [...(byFile.get(l.path) ?? []), l.text]);
		for (const [path, texts] of byFile) {
			lines.push(`- ${path}`);
			for (const t of texts.slice(0, LINES_PER_FILE)) lines.push(`    ${t}`);
			if (texts.length > LINES_PER_FILE) lines.push(`    … ${texts.length - LINES_PER_FILE} more`);
		}
	}
	return lines.join("\n");
}

/** The installed (or drafted) skill's name and description, for widen. */
export function currentSkill(db: Db, p: Pattern): { name: string | null; description: string | null } {
	if (p.inventoryId !== null) {
		const r = db
			.prepare("SELECT name, description FROM inventory WHERE id = ?")
			.get<{ name: string; description: string | null }>(p.inventoryId);
		if (r) return { name: r.name, description: r.description };
	}
	if (p.draftPath && existsSync(p.draftPath)) {
		try {
			// Only plain YAML front matter: a draft holds model output (gray-matter would run `---js`).
			const fm = frontMatter(readFileSync(p.draftPath, "utf8"));
			return {
				name: typeof fm.name === "string" ? fm.name : null,
				description: typeof fm.description === "string" ? fm.description : null,
			};
		} catch {
			// unreadable draft: no current skill
		}
	}
	return { name: null, description: null };
}

function instructions(p: Pattern, mode: DraftMode, db: Db): string {
	const scope =
		p.kind === "user_skill"
			? "a user-level Claude Code skill (it applies in every repo)"
			: "a Claude Code skill for this repo";
	if (mode === "widen") {
		const { name, description } = currentSkill(db, p);
		return [
			`The installed skill \`${name ?? p.label}\` is not triggering: Claude Code did not load it in the sessions below,`,
			"which did the task it covers. Write a revised `description` that would make Claude load it for prompts like",
			"their first prompts. Reply with the JSON object the schema describes; only `description` is used, keep `name`",
			"and leave `body`, `rule_text` and `target_file` empty or null.",
			`Current description: ${description ?? "(none)"}`,
		].join("\n");
	}
	if (mode === "rewrite_rule") {
		return [
			"The developer corrected Claude the same way in several sessions. Write one CLAUDE.md rule that would have",
			"prevented the corrections: `rule_text` is one imperative line; `target_file` is `CLAUDE.md` or",
			"`.claude/rules/<name>.md`. Reply with the JSON object the schema describes; `name` is a short kebab-case name,",
			"`description` and `body` may be empty.",
			"Corrections:",
			...(p.meta.corrections ?? [p.label]).map((c) => `- ${c}`),
		].join("\n");
	}
	return [
		`Write ${scope} for a task the developer repeated: "${p.label}" (${p.sessionIds.length} sessions).`,
		"Use only what the sessions below show. Reply with the JSON object the schema describes:",
		"- name: short kebab-case.",
		"- description: one or two sentences that make Claude load the skill for prompts like the first prompts below.",
		"- body: markdown with when to use it, the steps that worked (files, commands), and the checks to run at the end.",
		"- rule_text and target_file: null.",
		"Never repeat secrets, tokens, passwords or keys.",
	].join("\n");
}

/**
 * The draft prompt for the pattern and mode with the given kept lines per session. widen uses only the sessions that
 * did not invoke the skill. Sessions are added newest first while the prompt stays within DRAFT_CONTEXT_MAX.
 */
export function assembleDraftContext(
	db: Db,
	patternId: number,
	mode: DraftMode,
	kept: (sessionId: string) => KeptLines,
): DraftContext {
	const p = getPattern(db, patternId);
	if (!p) throw new UnknownPatternError(patternId);
	let ids = p.sessionIds;
	if (mode === "widen") {
		const { name } = currentSkill(db, p);
		const invoked = new Set(
			name === null
				? []
				: db
						.prepare(
							`SELECT DISTINCT session_id FROM tool_calls WHERE skill_name = ? AND session_id IN (${ids.map(() => "?").join(", ") || "''"})`,
						)
						.all<{ session_id: string }>(name, ...ids)
						.map((r) => r.session_id),
		);
		ids = ids.filter((id) => !invoked.has(id));
	}
	const head = instructions(p, mode, db);
	const blocks: string[] = [];
	const used: string[] = [];
	let unverified = false;
	let chars = head.length;
	for (const s of sessionInfo(db, ids)) {
		const k: KeptLines = mode === "create" ? kept(s.id) : { lines: [], verified: true };
		const block = mode === "widen" ? `- ${s.firstPrompt || "(no prompt)"}` : sessionBlock(s, k);
		if (blocks.length > 0 && chars + 2 + block.length > DRAFT_CONTEXT_MAX) break;
		blocks.push(
			block.length > DRAFT_CONTEXT_MAX - chars - 2 ? block.slice(0, Math.max(0, DRAFT_CONTEXT_MAX - chars - 3)) : block,
		);
		used.push(s.id);
		chars += 2 + block.length;
		if (!k.verified) unverified = true;
	}
	const title = mode === "widen" ? "## First prompts of sessions that did not load it" : "## Sessions (newest first)";
	const prompt = mode === "rewrite_rule" ? head : [head, title, ...blocks].join("\n\n");
	return { prompt, sessions: used, chars: prompt.length, unverified };
}

/** assembleDraftContext with each session's kept lines from git (keptAddedLines). */
export async function buildDraftContext(
	db: Db,
	patternId: number,
	opts: { mode: DraftMode } = { mode: "create" },
): Promise<DraftContext> {
	const p = getPattern(db, patternId);
	if (!p) throw new UnknownPatternError(patternId);
	const kept = new Map<string, KeptLines>();
	if (opts.mode === "create") for (const id of p.sessionIds) kept.set(id, await keptAddedLines(db, id));
	return assembleDraftContext(db, patternId, opts.mode, (id) => kept.get(id) ?? { lines: [], verified: true });
}

/** The context priced without git: every added line counts (an upper bound of the kept ones). */
export function estimateContextChars(db: Db, patternId: number, mode: DraftMode): number {
	return assembleDraftContext(db, patternId, mode, (id) => ({ lines: sessionAddedLines(db, id), verified: true }))
		.chars;
}

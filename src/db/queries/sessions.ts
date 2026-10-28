// GET /api/sessions and GET /api/sessions/:id (feature 12). Totals follow feature 02 (see totals.ts).

import { estimateReviewCost, reviewEligibility } from "../../coach/review";
import { sessionReviewBand } from "../../coach/review-band";
import { estimateSummaryCost } from "../../collector/summarize";
import { type Config, loadConfig } from "../../config";
import { decodePayload } from "../../ingest/line";
import type { Range, SessionDetail, SessionListItem, SessionType, Surface, UsedItem } from "../../server/types";
import type { Db } from "../adapter";
import { rangeStart } from "./range";
import { aiCallsToday } from "./selfUsage";
import { inProgressCutoff } from "./status";
import { totalsFor } from "./totals";

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 100;
const SUMMARY_LINE_MAX = 120;
const EXCERPT_MAX = 300;

type Row = {
	session_id: string;
	started_at: string;
	ended_at: string | null;
	surface: string;
	repo_id: string | null;
	repo_name: string | null;
	session_type: string | null;
	type_source: string | null;
	title: string | null;
	summary: string | null;
	models: string;
	capture: string;
	ended_evt: number;
	first_prompt: string | null;
};

const SELECT_ITEMS = `
	SELECT s.session_id, s.started_at, s.ended_at, s.surface, s.repo_id, r.name AS repo_name, s.session_type,
	  s.type_source, s.title, s.summary, s.models, s.capture,
	  EXISTS (SELECT 1 FROM events e WHERE e.session_id = s.session_id AND e.event = 'SessionEnd') AS ended_evt,
	  (SELECT t.user_text FROM turns t WHERE t.session_id = s.session_id AND t.user_text IS NOT NULL ORDER BY t.seq LIMIT 1)
	    AS first_prompt
	FROM sessions s LEFT JOIN repos r ON r.repo_id = s.repo_id`;

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Title, else the summary's first sentence, else the first prompt's first line (≤ 120 chars). */
function summaryLine(r: Row): string | null {
	if (r.title?.trim()) return clip(r.title.trim(), SUMMARY_LINE_MAX);
	if (r.summary?.trim()) return clip(r.summary.trim().split(/(?<=[.!?])\s/)[0], SUMMARY_LINE_MAX);
	const first = r.first_prompt?.trim().split("\n")[0].trim();
	return first ? clip(first, SUMMARY_LINE_MAX) : null;
}

function parseList(raw: string | null): string[] {
	try {
		const v: unknown = JSON.parse(raw ?? "[]");
		return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
	} catch {
		return [];
	}
}

/** The list row's review badge (Phase 5a): null while reviews are off; the estimate only on an eligible row. */
function listReview(db: Db, id: string, cfg: Config, now: Date): SessionListItem["review"] {
	if (!cfg.ai.review.enabled) return null;
	const e = reviewEligibility(db, id, cfg, now);
	if (e.reasons.includes("reviewed")) return { state: "reviewed", estUsd: null };
	return e.eligible ? { state: "eligible", estUsd: estimateReviewCost(db, id, cfg) } : { state: "none", estUsd: null };
}

/** List items for rows, with batched totals. */
function toItems(db: Db, rows: Row[], now: Date, cfg: Config = loadConfig()): SessionListItem[] {
	if (rows.length === 0) return [];
	const totals = totalsFor(
		db,
		rows.map(() => "?").join(", "),
		rows.map((r) => r.session_id),
	);
	const cutoff = inProgressCutoff(now);
	return rows.map((r) => {
		const t = totals.get(r.session_id);
		const inProgress = !r.ended_evt && r.ended_at !== null && r.ended_at >= cutoff;
		const endedAt = inProgress ? null : r.ended_at;
		return {
			id: r.session_id,
			startedAt: r.started_at,
			endedAt,
			surface: r.surface as Surface,
			repo: r.repo_id ? { id: r.repo_id, name: r.repo_name ?? r.repo_id } : null,
			type: (r.session_type as SessionType | null) ?? null,
			typeSource: (r.type_source as "ai" | "heuristic" | null) ?? null,
			summaryLine: summaryLine(r),
			tokens: t?.tokens ?? 0,
			costUsd: t?.costUsd ?? null,
			partial: t?.partial ?? true,
			tokensUnknown: !t?.hasUsage,
			durationSec: endedAt ? Math.round((Date.parse(endedAt) - Date.parse(r.started_at)) / 1000) : null,
			models: parseList(r.models),
			review: listReview(db, r.session_id, cfg, now),
			inProgress,
			imported: r.capture === "backfill",
		};
	});
}

// ---- Cursor: base64url of "<started_at>|<session_id>" ----

export const encodeCursor = (startedAt: string, id: string): string =>
	Buffer.from(`${startedAt}|${id}`, "utf8").toString("base64url");

/** The decoded cursor, or null when it is not one this server issued. */
export function decodeCursor(cursor: string): { startedAt: string; id: string } | null {
	if (!/^[A-Za-z0-9_-]+$/.test(cursor)) return null;
	const text = Buffer.from(cursor, "base64url").toString("utf8");
	const cut = text.indexOf("|");
	if (cut <= 0 || Number.isNaN(Date.parse(text.slice(0, cut)))) return null;
	return { startedAt: text.slice(0, cut), id: text.slice(cut + 1) };
}

const escapeLike = (q: string) => q.replace(/[\\%_]/g, (c) => `\\${c}`);

export type ListQuery = {
	range: Range;
	repo?: string;
	type?: SessionType;
	q?: string;
	cursor?: string;
	limit?: number;
	now: Date;
};

/** Sessions started in the range, newest first; search is a case-insensitive substring of prompts and summaries. */
export function listSessions(
	db: Db,
	opts: ListQuery,
): { items: SessionListItem[]; total: number; nextCursor: string | null } {
	const where = ["s.started_at >= ?"];
	const params: unknown[] = [rangeStart(opts.range, opts.now)];
	if (opts.repo) {
		where.push("s.repo_id = ?");
		params.push(opts.repo);
	}
	if (opts.type) {
		where.push("s.session_type = ?");
		params.push(opts.type);
	}
	if (opts.q?.trim()) {
		const like = `%${escapeLike(opts.q.trim())}%`;
		where.push(
			`(EXISTS (SELECT 1 FROM turns t WHERE t.session_id = s.session_id AND t.user_text LIKE ? ESCAPE '\\')
			  OR s.summary LIKE ? ESCAPE '\\')`,
		);
		params.push(like, like);
	}
	const total =
		db.prepare(`SELECT count(*) AS n FROM sessions s WHERE ${where.join(" AND ")}`).get<{ n: number }>(...params)?.n ??
		0;

	const cursor = opts.cursor ? decodeCursor(opts.cursor) : null;
	const pageWhere = [...where];
	const pageParams = [...params];
	if (cursor) {
		pageWhere.push("(s.started_at < ? OR (s.started_at = ? AND s.session_id < ?))");
		pageParams.push(cursor.startedAt, cursor.startedAt, cursor.id);
	}
	const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
	const rows = db
		.prepare(`${SELECT_ITEMS} WHERE ${pageWhere.join(" AND ")} ORDER BY s.started_at DESC, s.session_id DESC LIMIT ?`)
		.all<Row>(...pageParams, limit + 1);
	const page = rows.slice(0, limit);
	const last = page.at(-1);
	return {
		items: toItems(db, page, opts.now),
		total,
		nextCursor: rows.length > limit && last ? encodeCursor(last.started_at, last.session_id) : null,
	};
}

// ---- Detail ----

type CallRow = {
	turn_id: number | null;
	tool_name: string;
	input: Uint8Array | null;
	started_at: string | null;
	ended_at: string | null;
	ok: number | null;
	denied: string | null;
};

/** Chip label: the tool name; Bash / PowerShell with the command's first word; MCP tools by their full name. */
export function chipLabel(c: Pick<CallRow, "tool_name" | "input">): string {
	if ((c.tool_name === "Bash" || c.tool_name === "PowerShell") && c.input) {
		const input = decodePayload(c.input) as { command?: unknown } | null;
		const word = typeof input?.command === "string" ? input.command.trim().split(/\s+/)[0] : "";
		if (word) return `${c.tool_name} ${word}`;
	}
	return c.tool_name;
}

const durationMs = (c: { started_at: string | null; ended_at: string | null }) =>
	c.started_at && c.ended_at ? Math.max(0, Date.parse(c.ended_at) - Date.parse(c.started_at)) : null;

export function getSessionDetail(db: Db, id: string, now: Date = new Date()): SessionDetail | null {
	const row = db.prepare(`${SELECT_ITEMS} WHERE s.session_id = ?`).get<Row>(id);
	if (!row?.started_at) return null;
	const [item] = toItems(db, [row], now);
	const extra = db
		.prepare(
			"SELECT cwd, start_reason, permission_mode, summary, outcome, tags, summary_error FROM sessions WHERE session_id = ?",
		)
		.get<{
			cwd: string | null;
			start_reason: string | null;
			permission_mode: string | null;
			summary: string | null;
			outcome: string | null;
			tags: string | null;
			summary_error: string | null;
		}>(id);
	const t = totalsFor(db, "?", [id]).get(id);
	const cfg = loadConfig();

	const turns = db
		.prepare("SELECT id, seq, started_at, user_text, assistant_text FROM turns WHERE session_id = ? ORDER BY seq")
		.all<{
			id: number;
			seq: number;
			started_at: string | null;
			user_text: string | null;
			assistant_text: string | null;
		}>(id);
	const calls = db
		.prepare(
			`SELECT turn_id, tool_name, input, started_at, ended_at, ok, denied FROM tool_calls
			 WHERE session_id = ? AND agent_id IS NULL ORDER BY started_at, id`,
		)
		.all<CallRow>(id);
	const chips = new Map<
		number,
		Map<string, { label: string; count: number; totalMs: number | null; failures: number; denials: number }>
	>();
	for (const c of calls) {
		if (c.turn_id === null) continue;
		const byLabel = chips.get(c.turn_id) ?? new Map();
		const label = chipLabel(c);
		const chip = byLabel.get(label) ?? { label, count: 0, totalMs: null, failures: 0, denials: 0 };
		chip.count++;
		const ms = durationMs(c);
		if (ms !== null) chip.totalMs = (chip.totalMs ?? 0) + ms;
		if (c.denied !== null) chip.denials++;
		else if (c.ok === 0) chip.failures++;
		byLabel.set(label, chip);
		chips.set(c.turn_id, byLabel);
	}

	const files = db
		.prepare(
			// Per repo and path: repo-relative paths repeat across repos (review A6).
			`SELECT fc.path, r.name AS repo, sum(fc.lines_added) AS added, sum(fc.lines_removed) AS removed,
			   max(fc.language) AS language
			 FROM file_changes fc LEFT JOIN repos r ON r.repo_id = fc.repo_id
			 WHERE fc.session_id = ? GROUP BY fc.repo_id, fc.path
			 ORDER BY sum(fc.lines_added) + sum(fc.lines_removed) DESC, fc.path, r.name`,
		)
		.all<{ path: string; repo: string | null; added: number; removed: number; language: string | null }>(id);

	const invoked = (kind: string) =>
		db
			.prepare(
				`SELECT DISTINCT i.name FROM inventory_usage u JOIN inventory i ON i.id = u.inventory_id
				 WHERE u.session_id = ? AND u.invoked = 1 AND i.kind = ?`,
			)
			.all<{ name: string }>(id, kind)
			.map((r) => r.name);
	/** Calls and failures per value of a tool_calls column (failures: ok = 0 and not denied, feature 03). */
	const callCounts = (col: string, where = "") =>
		new Map(
			db
				.prepare(
					`SELECT ${col} AS name, count(*) AS calls, sum(ok = 0 AND denied IS NULL) AS failures FROM tool_calls
					 WHERE session_id = ? AND ${col} IS NOT NULL${where} GROUP BY ${col}`,
				)
				.all<UsedItem>(id)
				.map((r) => [r.name, { name: r.name, calls: r.calls, failures: r.failures ?? 0 }]),
		);
	/** Called items plus invoked inventory items with no call (a slash-command skill), by name. */
	const usedItems = (counts: Map<string, UsedItem>, kind: string): UsedItem[] =>
		[...new Set([...counts.keys(), ...invoked(kind)])]
			.sort((a, b) => a.localeCompare(b))
			.map((name) => counts.get(name) ?? { name, calls: 0, failures: 0 });
	const tools = [...callCounts("tool_name", " AND mcp_server IS NULL").values()].sort(
		(a, b) => b.calls - a.calls || a.name.localeCompare(b.name),
	);

	const turnSeq = new Map(turns.map((x) => [x.id, x.seq]));
	const subagents = db
		.prepare(
			`SELECT a.agent_id, a.agent_type, a.description,
			   (SELECT c.turn_id FROM tool_calls c WHERE c.session_id = a.session_id AND c.tool_use_id = a.tool_use_id LIMIT 1) AS turn_id,
			   (SELECT count(*) FROM tool_calls c WHERE c.session_id = a.session_id AND c.agent_id = a.agent_id) AS calls
			 FROM subagents a WHERE a.session_id = ? ORDER BY a.started_at, a.agent_id`,
		)
		.all<{
			agent_id: string;
			agent_type: string | null;
			description: string | null;
			turn_id: number | null;
			calls: number;
		}>(id);

	return {
		...item,
		cwd: extra?.cwd ?? "",
		startReason: extra?.start_reason ?? null,
		permissionMode: extra?.permission_mode ?? null,
		summary: extra?.summary ?? null,
		outcome: (extra?.outcome as SessionDetail["outcome"]) ?? null,
		tags: parseList(extra?.tags ?? null),
		summaryState: extra?.summary
			? "done"
			: !cfg.ai.summaries.enabled
				? "disabled"
				: extra?.summary_error
					? "error"
					: turns.length < 2
						? "skipped"
						: "pending",
		summaryError: extra?.summary_error ?? null,
		summaryEstUsd: estimateSummaryCost(db, cfg),
		summaryCapReached: aiCallsToday(db, "summary", now) >= cfg.ai.maxPerDay,
		resumeCommand: `claude --resume ${id}`,
		tokens: {
			input: t?.input ?? 0,
			cacheWrite: t?.cacheWrite ?? 0,
			cacheRead: t?.cacheRead ?? 0,
			output: t?.output ?? 0,
			costUsd: t?.costUsd ?? null,
			byModel: t?.byModel ?? [],
			unknown: !t?.hasUsage,
		},
		turns: turns.map((x) => ({
			seq: x.seq,
			startedAt: x.started_at ?? item.startedAt,
			userText: x.user_text ?? "",
			assistantExcerpt: x.assistant_text ? clip(x.assistant_text, EXCERPT_MAX) : null,
			tools: [...(chips.get(x.id)?.values() ?? [])],
		})),
		toolCallCount:
			db.prepare("SELECT count(*) AS n FROM tool_calls WHERE session_id = ?").get<{ n: number }>(id)?.n ?? 0,
		files,
		used: {
			skills: usedItems(callCounts("skill_name"), "skill"),
			mcpServers: usedItems(callCounts("mcp_server"), "mcp"),
			tools,
			instructionFiles: db
				.prepare(
					`SELECT file_path AS path, max(kind) AS kind, count(*) AS count FROM instructions_loaded
					 WHERE session_id = ? GROUP BY file_path ORDER BY count(*) DESC, file_path`,
				)
				.all<{ path: string; kind: string | null; count: number }>(id),
		},
		subagents: subagents.map((a) => ({
			agentId: a.agent_id,
			agentType: a.agent_type,
			description: a.description,
			turnSeq: a.turn_id === null ? null : (turnSeq.get(a.turn_id) ?? null),
			toolCalls: a.calls,
		})),
		compactions: db
			.prepare(
				`SELECT c.ts, c.trigger,
				   (SELECT max(t.seq) FROM turns t WHERE t.session_id = c.session_id AND t.started_at <= c.ts) AS after_seq
				 FROM compactions c WHERE c.session_id = ? ORDER BY c.ts, c.id`,
			)
			.all<{ ts: string; trigger: string | null; after_seq: number | null }>(id)
			.map((c) => ({ ts: c.ts, trigger: c.trigger, afterTurnSeq: c.after_seq })),
		review: sessionReviewBand(db, id, cfg, now),
	};
}

// AI session summaries (feature 06): the output schema, the fixed prompts, the heuristic session type used whenever
// there is no AI summary, the stored-turns prompt every summary sends, and the per-call cost
// estimate shown before the user spends anything.
import { z } from "zod";
import { ClaudeError, runClaude } from "../claude/headless";
import type { Config } from "../config";
import type { Db } from "../db/adapter";
import { aiCallsToday } from "../db/queries/selfUsage";
import { decodePayload } from "../ingest/line";
import { redactDeep } from "../redact";
import { estimateCost, modelFamily, PRICE_TABLE } from "./prices";

export const SESSION_TYPES = ["feature", "bugfix", "refactor", "exploration", "ops", "docs", "other"] as const;
export const OUTCOMES = ["completed", "partial", "abandoned", "unclear"] as const;
export type SessionType = (typeof SESSION_TYPES)[number];
export type Outcome = (typeof OUTCOMES)[number];

const MAX_TAGS = 5;

/** What a summary call must return. Extra keys are dropped; more than 5 tags are cut, not rejected (no retry spent). */
export const SummaryResultSchema = z.object({
	summary: z.string().trim().min(1).max(2000),
	session_type: z.enum(SESSION_TYPES),
	tags: z
		.array(z.string().trim().min(1).max(40))
		.transform((t) => t.slice(0, MAX_TAGS))
		.default([]),
	outcome: z.enum(OUTCOMES),
});
export type SummaryResult = z.output<typeof SummaryResultSchema>;

/** The JSON Schema passed to `claude -p --json-schema`. */
export const SUMMARY_JSON_SCHEMA = {
	type: "object",
	properties: {
		summary: { type: "string", description: "2-4 sentences: what was asked, what was done, where it ended" },
		session_type: { type: "string", enum: [...SESSION_TYPES] },
		tags: { type: "array", items: { type: "string" }, maxItems: MAX_TAGS },
		outcome: { type: "string", enum: [...OUTCOMES] },
	},
	required: ["summary", "session_type", "tags", "outcome"],
	additionalProperties: false,
} as const;

// ---- Heuristic type (feature 06 rules, in order; "mostly" = more than half of the session's tool calls) ----

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);
const EXPLORE_TOOLS = new Set(["Read", "Grep", "Glob"]);

function isTestPath(path: string): boolean {
	const p = `/${path.replace(/\\/g, "/").toLowerCase()}`;
	if (/\/(tests?|__tests__|spec)\//.test(p)) return true;
	const name = p.slice(p.lastIndexOf("/") + 1);
	return /\.(test|spec)\./.test(name) || name.startsWith("test_") || /_test\.[^.]+$/.test(name);
}

export function heuristicType(toolCalls: { tool_name: string; path?: string | null }[]): SessionType {
	const total = toolCalls.length;
	if (total === 0) return "other";
	const edits = toolCalls.filter((c) => EDIT_TOOLS.has(c.tool_name));
	if (edits.length > 0 && edits.every((c) => (c.path ?? "").toLowerCase().endsWith(".md"))) return "docs";
	if (edits.length > total / 2) {
		const onTests = edits.filter((c) => c.path && isTestPath(c.path)).length;
		if (onTests > edits.length / 2) return "bugfix";
	}
	if (toolCalls.filter((c) => EXPLORE_TOOLS.has(c.tool_name)).length > total / 2) return "exploration";
	return "other";
}

// ---- Prompts ----

/** Fixed instructions; runClaude() adds the sentinel line, summarizeSession() appends the stored turns. */
export function buildSummaryPrompt(): string {
	return [
		"Summarize the condensed transcript below: a Claude Code session, for the developer's own records.",
		"Only describe what happened; do not continue the work.",
		"Reply with the JSON object the schema describes:",
		"- summary: 2-4 sentences, plain words, on what was asked, what was done and where it ended. No preamble.",
		"- session_type: one of feature, bugfix, refactor, exploration, ops, docs, other.",
		"- tags: up to 5 short lowercase tags (languages, components, tools).",
		"- outcome: completed, partial, abandoned or unclear.",
		"Never repeat secrets, tokens, passwords or keys.",
	].join("\n");
}

const PROMPT_MAX = 2000; // characters of one user prompt
const REPLY_MAX = 600; // characters of one reply excerpt
const DETAIL_MAX = 80;

type ToolRow = { turn_id: number | null; tool_name: string; input: Uint8Array | null; ok: number | null };

function toolDetail(name: string, input: unknown): string | null {
	const i = (input ?? {}) as Record<string, unknown>;
	if (EDIT_TOOLS.has(name) || name === "NotebookEdit") {
		const p = i.file_path ?? i.notebook_path ?? i.path;
		return typeof p === "string" ? p : null;
	}
	if (name === "Bash" || name === "PowerShell") {
		return typeof i.command === "string" ? i.command.replace(/\s+/g, " ").trim().slice(0, DETAIL_MAX) : null;
	}
	return null;
}

/** "Read ×3, Edit src/a.ts, Bash npm test (failed)": consecutive identical entries folded. */
function toolSkeleton(rows: ToolRow[]): string {
	const parts: { label: string; n: number }[] = [];
	for (const r of rows) {
		let input: unknown = null;
		try {
			input = r.input ? decodePayload(r.input) : null;
		} catch {
			input = null;
		}
		const detail = toolDetail(r.tool_name, input);
		const label = `${r.tool_name}${detail ? ` ${detail}` : ""}${r.ok === 0 ? " (failed)" : ""}`;
		const last = parts.at(-1);
		if (last && last.label === label) last.n++;
		else parts.push({ label, n: 1 });
	}
	return parts.map((p) => (p.n > 1 ? `${p.label} ×${p.n}` : p.label)).join(", ");
}

const clip = (s: string | null, max: number) => {
	const t = (s ?? "").trim();
	return t.length > max ? `${t.slice(0, max)}…` : t;
};

/**
 * The session as plain text from our own derived turns and tool calls (never the raw stored lines), for a summary
 * (never --resume, review 2026-10-10). Oldest turns are dropped first to fit maxChars, with a line saying how many.
 */
export function buildStoredTurnsPrompt(db: Db, sessionId: string, maxChars = 60_000): string {
	const turns = db
		.prepare("SELECT id, seq, user_text, assistant_text FROM turns WHERE session_id = ? ORDER BY seq")
		.all<{ id: number; seq: number; user_text: string | null; assistant_text: string | null }>(sessionId);
	const tools = db
		.prepare(
			`SELECT turn_id, tool_name, input, ok FROM tool_calls
			 WHERE session_id = ? AND agent_id IS NULL ORDER BY started_at, id`,
		)
		.all<ToolRow>(sessionId);
	const byTurn = new Map<number, ToolRow[]>();
	for (const t of tools) {
		if (t.turn_id === null) continue;
		const list = byTurn.get(t.turn_id) ?? [];
		list.push(t);
		byTurn.set(t.turn_id, list);
	}
	const blocks = turns.map((t, i) => {
		const lines = [`Turn ${i + 1}`, `You: ${clip(t.user_text, PROMPT_MAX)}`];
		const skeleton = toolSkeleton(byTurn.get(t.id) ?? []);
		if (skeleton) lines.push(`Tools: ${skeleton}`);
		if (t.assistant_text?.trim()) lines.push(`Claude: ${clip(t.assistant_text, REPLY_MAX)}`);
		return lines.join("\n");
	});

	const header = "Session transcript (condensed from stored turns):";
	const join = (kept: string[], omitted: number) =>
		[header, ...(omitted > 0 ? [`[… ${omitted} earlier turns omitted]`] : []), ...kept].join("\n\n");
	let start = 0;
	let text = join(blocks, 0);
	while (text.length > maxChars && start < blocks.length - 1) {
		start++;
		text = join(blocks.slice(start), start);
	}
	return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

// ---- Cost estimate (spec decision 2) ----

const SAMPLE_CALLS = 20;
const MIN_CALLS = 3;

/** A full model id for an alias such as "sonnet" (the newest family in the price table), else the id itself. */
export function priceableModel(model: string): string {
	if (modelFamily(model) !== null) return model;
	const alias = model.toLowerCase();
	return Object.keys(PRICE_TABLE).find((k) => k.includes(`-${alias}-`)) ?? model;
}

/** Mean of the last 20 summary calls; with fewer than 3, 8,000 input + 400 output tokens on ai.model (or the
 * user's most-used model). Null when neither is known. */
export function estimateSummaryCost(db: Db, cfg: Config): number | null {
	const recent = db
		.prepare(
			`SELECT avg(cost_usd) AS mean, count(*) AS n FROM (
			   SELECT cost_usd FROM self_usage WHERE feature = 'summary' AND cost_usd IS NOT NULL ORDER BY ts DESC LIMIT ?)`,
		)
		.get<{ mean: number | null; n: number }>(SAMPLE_CALLS);
	if (recent && recent.n >= MIN_CALLS && recent.mean !== null) return recent.mean;
	const model =
		cfg.ai.model ??
		db
			.prepare(
				"SELECT model FROM usage WHERE model IS NOT NULL GROUP BY model ORDER BY count(*) DESC, max(ts) DESC LIMIT 1",
			)
			.get<{ model: string }>()?.model;
	if (!model) return null;
	return estimateCost({
		model: priceableModel(model),
		inputTokens: 8000,
		outputTokens: 400,
		cacheCreationTokens: 0,
		cacheCreation1hTokens: 0,
		cacheReadTokens: 0,
	});
}

// ---- summarizeSession (feature 06 steps 1-9; spec decision 3) ----

const OPEN_WINDOW_MS = 24 * 3_600_000; // a session without SessionEnd counts as ended after 24 h without new lines
const ERROR_DETAIL = 120;

export type SummaryStatus = "done" | "skipped" | "capped" | "error";
export type SummaryOutcome = { status: SummaryStatus; costUsd: number | null; reason: string | null };

type SessionRow = { capture: string; ended_at: string | null; type_source: string | null };

function toolCallsForHeuristic(db: Db, sessionId: string): { tool_name: string; path: string | null }[] {
	return db
		.prepare("SELECT tool_name, input FROM tool_calls WHERE session_id = ? AND agent_id IS NULL")
		.all<{ tool_name: string; input: Uint8Array | null }>(sessionId)
		.map((c) => {
			let path: string | null = null;
			try {
				const i = (c.input ? decodePayload(c.input) : null) as Record<string, unknown> | null;
				const p = i?.file_path ?? i?.notebook_path ?? i?.path;
				path = typeof p === "string" ? p : null;
			} catch {
				path = null;
			}
			return { tool_name: c.tool_name, path };
		});
}

function applyHeuristic(db: Db, sessionId: string): void {
	db.prepare(
		"UPDATE sessions SET session_type = ?, type_source = 'heuristic' WHERE session_id = ? AND type_source IS NOT 'ai'",
	).run(heuristicType(toolCallsForHeuristic(db, sessionId)), sessionId);
}

/** SQL over a sessions alias: ended = a SessionEnd event, or no new line for 24 h (the second parameter is the cutoff). */
const endedSql = (alias: string) =>
	`(EXISTS (SELECT 1 FROM events e WHERE e.session_id = ${alias}.session_id AND e.event = 'SessionEnd')
	  OR ${alias}.ended_at < ?)`;

function isEnded(db: Db, sessionId: string, now: Date): boolean {
	return (
		db
			.prepare(`SELECT 1 AS x FROM sessions s WHERE s.session_id = ? AND ${endedSql("s")}`)
			.get(sessionId, new Date(now.getTime() - OPEN_WINDOW_MS).toISOString()) !== undefined
	);
}

/**
 * Pending summaries (architecture "Pending summaries"): ended sessions with at least 2 turns, no AI summary and no
 * summary_error, oldest first. capture "hooks" is what catch-up and plain `enrich` take; "backfill" needs an explicit
 * request.
 */
export function pendingSummaryIds(
	db: Db,
	opts: { capture?: "hooks" | "backfill"; since?: Date; limit?: number; now?: Date } = {},
): string[] {
	const now = opts.now ?? new Date();
	// Plain ? only: node:sqlite in Node 22.13 mis-binds numbered parameters.
	const capture = opts.capture ?? null;
	const since = opts.since?.toISOString() ?? null;
	return db
		.prepare(
			`SELECT s.session_id FROM sessions s
			 WHERE s.type_source IS NOT 'ai' AND s.summary_error IS NULL
			   AND (? IS NULL OR s.capture = ?) AND (? IS NULL OR s.started_at >= ?)
			   AND (SELECT count(*) FROM turns t WHERE t.session_id = s.session_id) >= 2
			   AND (EXISTS (SELECT 1 FROM events e WHERE e.session_id = s.session_id AND e.event = 'SessionEnd')
			        OR s.ended_at < ?)
			 ORDER BY s.started_at IS NULL, s.started_at, s.session_id LIMIT ?`,
		)
		.all<{ session_id: string }>(
			capture,
			capture,
			since,
			since,
			new Date(now.getTime() - OPEN_WINDOW_MS).toISOString(),
			opts.limit ?? -1,
		)
		.map((r) => r.session_id);
}

function errorText(e: unknown): string {
	if (e instanceof ClaudeError) {
		const msg = e.message.slice(0, ERROR_DETAIL);
		return msg.startsWith(e.reason) ? msg : `${e.reason}: ${msg}`;
	}
	return `error: ${String((e as Error)?.message ?? e).slice(0, ERROR_DETAIL)}`;
}

/** summarizeSession() with the cost of the successful call and the reason for anything but "done". */
export async function summarizeSessionResult(
	db: Db,
	sessionId: string,
	cfg: Config,
	opts: { explicit?: boolean; now?: Date; timeoutMs?: number } = {},
): Promise<SummaryOutcome> {
	const now = opts.now ?? new Date();
	const s = db
		.prepare("SELECT capture, ended_at, type_source FROM sessions WHERE session_id = ?")
		.get<SessionRow>(sessionId);
	if (!s) return { status: "skipped", costUsd: null, reason: "unknown session" };
	if (s.type_source === "ai") return { status: "skipped", costUsd: null, reason: "already summarized" };
	const skip = (reason: string): SummaryOutcome => {
		applyHeuristic(db, sessionId);
		return { status: "skipped", costUsd: null, reason };
	};
	if (!cfg.ai.summaries.enabled) return skip("summaries are off");
	const turns =
		db.prepare("SELECT count(*) AS n FROM turns WHERE session_id = ?").get<{ n: number }>(sessionId)?.n ?? 0;
	if (turns < 2) return skip("< 2 turns");
	if (!isEnded(db, sessionId, now)) return skip("still open");
	if (s.capture === "backfill" && !opts.explicit) return skip("imported");
	if (aiCallsToday(db, "summary", now) >= cfg.ai.maxPerDay) {
		applyHeuristic(db, sessionId);
		return { status: "capped", costUsd: null, reason: "daily cap reached" };
	}

	// Always the stored turns, never --resume (review 2026-10-10: a resume with tools off misses the prompt cache).
	const prompt = `${buildSummaryPrompt()}\n\n${buildStoredTurnsPrompt(db, sessionId)}`;

	let lastError: unknown;
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const r = await runClaude<unknown>({
				prompt,
				schema: SUMMARY_JSON_SCHEMA,
				feature: "summary",
				model: cfg.ai.model,
				timeoutMs: opts.timeoutMs,
				db,
				targetSessionId: sessionId,
				// Re-checked atomically for every attempt: another worker may have used the last slot.
				cap: cfg.ai.maxPerDay,
				now,
			});
			const parsed = SummaryResultSchema.safeParse(r.result);
			if (!parsed.success) throw new ClaudeError("schema", `schema: ${parsed.error.issues[0]?.message ?? "invalid"}`);
			const v = redactDeep(parsed.data, cfg.capture.redact, cfg.capture.maxFieldBytes);
			db.prepare(
				`UPDATE sessions SET summary = ?, session_type = ?, tags = ?, outcome = ?, type_source = 'ai',
				 summary_error = NULL WHERE session_id = ?`,
			).run(v.summary, v.session_type, JSON.stringify(v.tags), v.outcome, sessionId);
			return { status: "done", costUsd: r.costUsd, reason: null };
		} catch (e) {
			// A missing claude is the environment, not this session: no retry, no summary_error, so the session stays
			// pending and catch-up / enrich pick it up once claude is on PATH (common for VS Code and desktop users).
			if (e instanceof ClaudeError && e.reason === "not_found") {
				applyHeuristic(db, sessionId);
				return { status: "skipped", costUsd: null, reason: "claude is not on PATH" };
			}
			if (e instanceof ClaudeError && e.reason === "capped") {
				applyHeuristic(db, sessionId);
				return { status: "capped", costUsd: null, reason: "daily cap reached" };
			}
			lastError = e;
			// The budget is spent after a paid turn: the same prompt would fail the same way at the same price.
			if (e instanceof ClaudeError && e.reason === "budget") break;
		}
	}
	const reason = errorText(lastError);
	db.prepare("UPDATE sessions SET summary_error = ? WHERE session_id = ?").run(reason, sessionId);
	applyHeuristic(db, sessionId);
	return { status: "error", costUsd: null, reason };
}

/** Summarizes one session through the user's own Claude Code login, within the daily cap; explicit allows imported
 * sessions. Never throws for a failed call: the reason goes to summary_error. */
export async function summarizeSession(
	db: Db,
	sessionId: string,
	cfg: Config,
	opts: { explicit?: boolean; now?: Date } = {},
): Promise<SummaryStatus> {
	return (await summarizeSessionResult(db, sessionId, cfg, opts)).status;
}

// Price-table fallback sizes for features without call history (decision: reviews read a longer prompt).
const FALLBACK_TOKENS: Record<"review" | "draft", { input: number; output: number }> = {
	review: { input: 30_000, output: 1_500 },
	draft: { input: 20_000, output: 2_000 },
};

/** Per-call cost note for enabling reviews or drafts: the feature's 30-day mean, else a price-table estimate. */
export function estimateFeatureCost(
	db: Db,
	cfg: Config,
	feature: "review" | "draft",
	now: Date = new Date(),
): number | null {
	const since = new Date(now.getTime() - 30 * 86_400_000).toISOString();
	const mean = db
		.prepare("SELECT avg(cost_usd) AS mean FROM self_usage WHERE feature = ? AND cost_usd IS NOT NULL AND ts >= ?")
		.get<{ mean: number | null }>(feature, since)?.mean;
	if (mean !== null && mean !== undefined) return mean;
	const model =
		cfg.ai.model ??
		db
			.prepare(
				"SELECT model FROM usage WHERE model IS NOT NULL GROUP BY model ORDER BY count(*) DESC, max(ts) DESC LIMIT 1",
			)
			.get<{ model: string }>()?.model;
	if (!model) return null;
	const t = FALLBACK_TOKENS[feature];
	return estimateCost({
		model: priceableModel(model),
		inputTokens: t.input,
		outputTokens: t.output,
		cacheCreationTokens: 0,
		cacheCreation1hTokens: 0,
		cacheReadTokens: 0,
	});
}

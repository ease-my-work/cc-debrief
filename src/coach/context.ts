// loadSessionContext() (feature 07 "Context"): everything the Tier 1 signals read about one session, loaded once.
// Signals stay pure functions over this object.
import type { Db } from "../db/adapter";
import { parseToolName } from "../derive/tools";
import { decodePayload } from "../ingest/line";
import type { ContextInventoryItem, ContextToolCall, ContextUsage, SessionContext } from "./types";

const DAY_MS = 86_400_000;
/** Sessions needed before a median cache share means anything (feature 07). */
const MIN_PRIOR_SESSIONS = 5;
/** Bytes of tool_calls.response.excerpt (derive EXCERPT_BYTES): a longer result's excerpt ends in its own marker. */
const EXCERPT_BYTES = 4096;
const MARKER_N = /…\[truncated (\d+) bytes\]$/;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function decodeObj(blob: Uint8Array | null): Record<string, unknown> {
	if (!blob) return {};
	try {
		const v = decodePayload(blob);
		return isObj(v) ? v : {};
	} catch {
		return {};
	}
}

/**
 * Original size of a tool result: `origBytes` (derive records it when the stored text was cut), else `bytes` plus N
 * from a marker in an excerpt that is the whole result (rows derived before origBytes existed), else `bytes`.
 */
function responseBytes(response: Record<string, unknown>): number {
	if (typeof response.origBytes === "number") return response.origBytes;
	const bytes = typeof response.bytes === "number" ? response.bytes : 0;
	const excerpt = typeof response.excerpt === "string" ? response.excerpt : "";
	const m = bytes <= EXCERPT_BYTES ? MARKER_N.exec(excerpt) : null;
	return m ? bytes - Buffer.byteLength(m[0], "utf8") + Number(m[1]) : bytes;
}

/** Median of fractions (no rounding, unlike stats.median); null when empty. */
function medianOf(values: number[]): number | null {
	if (values.length === 0) return null;
	const s = [...values].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * A usage row's tokens as findings cost them (Phase 4 tuning): input, cache writes and output. Cache reads are left
 * out: they are cheap and dominate every long session, so counting them made every cost look the same.
 */
export const costTokensOf = (u: ContextUsage): number => u.input + u.output + u.cacheCreation;

export type SessionShare = { sessionId: string; startedAt: string; share: number };

/**
 * Cache share (cache_read ÷ input-side tokens) of every session that started in [from, to) and has input-side
 * usage. Sessions drive the join (sessions_started, then usage_session), so it never scans all of usage.
 */
export function sessionCacheShares(db: Db, from: string, to: string): SessionShare[] {
	return db
		.prepare(
			`SELECT s.session_id, s.started_at, sum(u.cache_read_tokens) AS cr,
			   sum(u.input_tokens + u.cache_creation_tokens + u.cache_read_tokens) AS side
			 FROM sessions s CROSS JOIN usage u ON u.session_id = s.session_id
			 WHERE s.started_at >= ? AND s.started_at < ?
			 GROUP BY s.session_id HAVING side > 0`,
		)
		.all<{ session_id: string; started_at: string; cr: number; side: number }>(from, to)
		.map((r) => ({ sessionId: r.session_id, startedAt: r.started_at, share: r.cr / r.side }));
}

/**
 * Median cache share of the other sessions that started in the 30 days before this one; null with fewer than
 * MIN_PRIOR_SESSIONS. Anchored on the session's own start, so a re-check of history gives the same answer. `shares`
 * (a sessionCacheShares() list covering the window) saves the query when many sessions are checked in a row.
 */
function userMedianCacheShare(
	db: Db,
	sessionId: string,
	anchor: string | null,
	shares?: SessionShare[],
): number | null {
	if (!anchor) return null;
	const from = new Date(Date.parse(anchor) - 30 * DAY_MS).toISOString();
	const window = (shares ?? sessionCacheShares(db, from, anchor))
		.filter((s) => s.sessionId !== sessionId && s.startedAt >= from && s.startedAt < anchor)
		.map((s) => s.share);
	return window.length < MIN_PRIOR_SESSIONS ? null : medianOf(window);
}

export function loadSessionContext(db: Db, sessionId: string, opts: { shares?: SessionShare[] } = {}): SessionContext {
	const s = db
		.prepare(
			`SELECT session_id, started_at, ended_at, cwd, repo_id, head_end, session_type, capture
			 FROM sessions WHERE session_id = ?`,
		)
		.get<{
			session_id: string;
			started_at: string | null;
			ended_at: string | null;
			cwd: string | null;
			repo_id: string | null;
			head_end: string | null;
			session_type: string | null;
			capture: "hooks" | "backfill";
		}>(sessionId);
	if (!s) throw new Error(`no session ${sessionId}`);

	const turnRows = db
		.prepare("SELECT id, seq, user_text, started_at, ended_at FROM turns WHERE session_id = ? ORDER BY seq")
		.all<{ id: number; seq: number; user_text: string | null; started_at: string | null; ended_at: string | null }>(
			sessionId,
		);
	const seqOf = new Map(turnRows.map((t) => [t.id, t.seq]));

	const usage: ContextUsage[] = db
		.prepare(
			`SELECT turn_id, agent_id, ts, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens
			 FROM usage WHERE session_id = ? ORDER BY ts, id`,
		)
		.all<{
			turn_id: number | null;
			agent_id: string | null;
			ts: string | null;
			model: string | null;
			input_tokens: number;
			output_tokens: number;
			cache_creation_tokens: number;
			cache_read_tokens: number;
		}>(sessionId)
		.map((u) => ({
			turnSeq: u.turn_id === null ? null : (seqOf.get(u.turn_id) ?? null),
			agentId: u.agent_id,
			ts: u.ts,
			model: u.model,
			input: u.input_tokens,
			output: u.output_tokens,
			cacheCreation: u.cache_creation_tokens,
			cacheRead: u.cache_read_tokens,
		}));
	const turnTokens = new Map<number, number>();
	for (const u of usage)
		if (u.turnSeq !== null) turnTokens.set(u.turnSeq, (turnTokens.get(u.turnSeq) ?? 0) + costTokensOf(u));
	const totals = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, tokens: 0 };
	for (const u of usage) {
		totals.input += u.input;
		totals.output += u.output;
		totals.cacheCreation += u.cacheCreation;
		totals.cacheRead += u.cacheRead;
		totals.tokens += costTokensOf(u);
	}

	const toolCalls: ContextToolCall[] = db
		.prepare(
			`SELECT id, tool_name, mcp_server, mcp_source, mcp_tool, skill_name, input, response, started_at, ended_at, ok,
			   denied, exit_code, turn_id, agent_id
			 FROM tool_calls WHERE session_id = ? ORDER BY started_at, id`,
		)
		.all<{
			id: number;
			tool_name: string;
			mcp_server: string | null;
			mcp_source: string | null;
			mcp_tool: string | null;
			skill_name: string | null;
			input: Uint8Array | null;
			response: Uint8Array | null;
			started_at: string | null;
			ended_at: string | null;
			ok: number | null;
			denied: string | null;
			exit_code: number | null;
			turn_id: number | null;
			agent_id: string | null;
		}>(sessionId)
		.map((c) => ({
			id: c.id,
			toolName: c.tool_name,
			mcpServer: c.mcp_server,
			mcpSource: c.mcp_source,
			mcpTool: c.mcp_tool,
			skillName: c.skill_name,
			input: decodeObj(c.input),
			ok: c.ok === null ? null : c.ok === 1,
			denied: c.denied,
			exitCode: c.exit_code,
			startedAt: c.started_at,
			endedAt: c.ended_at,
			turnSeq: c.turn_id === null ? null : (seqOf.get(c.turn_id) ?? null),
			agentId: c.agent_id,
			// Only context churn reads response sizes, and only for Read calls: skip inflating the rest.
			responseBytes: c.tool_name === "Read" ? responseBytes(decodeObj(c.response)) : 0,
		}));

	const permissionRequests = db
		.prepare("SELECT ts, payload FROM events WHERE session_id = ? AND event = 'PermissionRequest' ORDER BY ts, id")
		.all<{ ts: string; payload: string }>(sessionId)
		.map((e) => {
			let tool = "";
			try {
				const p = JSON.parse(e.payload) as Record<string, unknown>;
				if (typeof p.tool_name === "string") tool = p.tool_name;
			} catch {
				// malformed payload: counted under ''
			}
			return { tool, at: e.ts, mcpServer: parseToolName(tool, null).mcpServer };
		});

	const inventory: ContextInventoryItem[] = db
		.prepare(
			`SELECT i.id, i.kind, i.scope, i.repo_id, i.name, i.description, i.meta, u.loaded, u.invoked
			 FROM inventory_usage u JOIN inventory i ON i.id = u.inventory_id
			 WHERE u.session_id = ? AND i.kind IN ('skill', 'mcp') ORDER BY i.id`,
		)
		.all<{
			id: number;
			kind: ContextInventoryItem["kind"];
			scope: ContextInventoryItem["scope"];
			repo_id: string | null;
			name: string;
			description: string | null;
			meta: string;
			loaded: number;
			invoked: number;
		}>(sessionId)
		.map((i) => {
			let meta: Record<string, unknown> = {};
			try {
				const m = JSON.parse(i.meta);
				if (isObj(m)) meta = m;
			} catch {
				// keep {}
			}
			return {
				id: i.id,
				kind: i.kind,
				scope: i.scope,
				repoId: i.repo_id,
				name: i.name,
				description: i.description,
				meta,
				loaded: i.loaded === 1,
				invoked: i.invoked === 1,
			};
		});

	return {
		session: {
			sessionId: s.session_id,
			startedAt: s.started_at,
			endedAt: s.ended_at,
			cwd: s.cwd,
			repoId: s.repo_id,
			headEnd: s.head_end,
			sessionType: s.session_type,
		},
		capture: s.capture,
		turns: turnRows.map((t) => ({
			id: t.id,
			seq: t.seq,
			userText: t.user_text,
			startedAt: t.started_at,
			endedAt: t.ended_at,
			tokens: turnTokens.get(t.seq) ?? 0,
		})),
		toolCalls,
		usage,
		totals,
		permissionRequests,
		compactions: db
			.prepare("SELECT ts FROM compactions WHERE session_id = ? ORDER BY ts, id")
			.all<{ ts: string | null }>(sessionId)
			.map((r) => ({ at: r.ts })),
		subagents: db
			.prepare(
				"SELECT agent_id, agent_type, started_at, ended_at FROM subagents WHERE session_id = ? ORDER BY started_at",
			)
			.all<{ agent_id: string; agent_type: string | null; started_at: string | null; ended_at: string | null }>(
				sessionId,
			)
			.map((r) => ({ agentId: r.agent_id, agentType: r.agent_type, startedAt: r.started_at, endedAt: r.ended_at })),
		fileChanges: db
			.prepare(
				"SELECT tool_call_id, path, repo_id, lines_added, lines_removed FROM file_changes WHERE session_id = ? ORDER BY id",
			)
			.all<{
				tool_call_id: number | null;
				path: string;
				repo_id: string | null;
				lines_added: number;
				lines_removed: number;
			}>(sessionId)
			.map((r) => ({
				toolCallId: r.tool_call_id,
				path: r.path,
				repoId: r.repo_id,
				linesAdded: r.lines_added,
				linesRemoved: r.lines_removed,
			})),
		inventory,
		userMedianCacheShare: userMedianCacheShare(db, sessionId, s.started_at ?? s.ended_at, opts.shares),
	};
}

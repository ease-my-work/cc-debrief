// In-memory SessionContext builder for signal tests (Phase 4 plan, Task 2). ctx() returns a valid 10-turn session:
// one turn every 3 minutes from BASE, one usage row per turn. Turn tokens and totals are recomputed from `usage`
// unless the override sets them, so a test only states the rows it cares about.
import { costTokensOf } from "../../src/coach/context";
import type {
	ContextInventoryItem,
	ContextToolCall,
	ContextTurn,
	ContextUsage,
	SessionContext,
} from "../../src/coach/types";

export const BASE = Date.parse("2026-10-01T10:00:00.000Z");
/** ISO time `min` minutes (and `sec` seconds) after BASE. */
export const at = (min: number, sec = 0): string => new Date(BASE + min * 60_000 + sec * 1000).toISOString();

export const turn = (seq: number, text: string | null = `prompt ${seq}`, start = at((seq - 1) * 3)): ContextTurn => ({
	id: seq,
	seq,
	userText: text,
	startedAt: start,
	endedAt: new Date(Date.parse(start) + 2 * 60_000).toISOString(),
	tokens: 0,
});

let nextCallId = 1;
export function call(
	tool: string,
	input: Record<string, unknown> = {},
	o: {
		ok?: boolean | null;
		turn?: number;
		at?: string;
		ms?: number;
		denied?: string | null;
		agentId?: string | null;
		exitCode?: number | null;
		bytes?: number;
		mcp?: { server: string; source?: string | null; tool?: string };
		skill?: string;
	} = {},
): ContextToolCall {
	const start = o.at ?? at(((o.turn ?? 1) - 1) * 3, 30);
	return {
		id: nextCallId++,
		toolName: tool,
		mcpServer: o.mcp?.server ?? null,
		mcpSource: o.mcp?.source ?? null,
		mcpTool: o.mcp?.tool ?? null,
		skillName: o.skill ?? null,
		input,
		ok: o.ok === undefined ? true : o.ok,
		denied: o.denied ?? null,
		exitCode: o.exitCode ?? null,
		startedAt: start,
		endedAt: new Date(Date.parse(start) + (o.ms ?? 1000)).toISOString(),
		turnSeq: o.turn ?? 1,
		agentId: o.agentId ?? null,
		responseBytes: o.bytes ?? 0,
	};
}

export const usage = (
	turnSeq: number | null,
	t: {
		input?: number;
		output?: number;
		cacheCreation?: number;
		cacheRead?: number;
		ts?: string;
		agentId?: string;
	} = {},
): ContextUsage => ({
	turnSeq,
	agentId: t.agentId ?? null,
	ts: t.ts ?? at(((turnSeq ?? 1) - 1) * 3, 45),
	model: "claude-sonnet-4-5",
	input: t.input ?? 0,
	output: t.output ?? 0,
	cacheCreation: t.cacheCreation ?? 0,
	cacheRead: t.cacheRead ?? 0,
});

export const permission = (tool: string, when: string, mcpServer: string | null = null) => ({
	tool,
	at: when,
	mcpServer,
});
export const compaction = (when: string | null = at(10)) => ({ at: when });

let nextItemId = 1;
export const skill = (
	name: string,
	description: string | null,
	o: { loaded?: boolean; invoked?: boolean } = {},
): ContextInventoryItem => ({
	id: nextItemId++,
	kind: "skill",
	scope: "user",
	repoId: null,
	name,
	description,
	meta: {},
	loaded: o.loaded ?? true,
	invoked: o.invoked ?? false,
});
export const mcp = (
	name: string,
	o: { url?: string; command?: string; loaded?: boolean; invoked?: boolean } = {},
): ContextInventoryItem => ({
	id: nextItemId++,
	kind: "mcp",
	scope: "user",
	repoId: null,
	name,
	description: null,
	meta: { ...(o.url ? { type: "http", url: o.url } : { type: "stdio" }), ...(o.command ? { command: o.command } : {}) },
	loaded: o.loaded ?? true,
	invoked: o.invoked ?? false,
});

/** The default 10 turns, 3 minutes apart, ending 2 minutes after the last turn starts. */
const defaultTurns = (): ContextTurn[] => Array.from({ length: 10 }, (_, i) => turn(i + 1));
const defaultUsage = (): ContextUsage[] =>
	Array.from({ length: 10 }, (_, i) => usage(i + 1, { input: 100, output: 50, cacheRead: 300 }));

export function ctx(overrides: Partial<SessionContext> = {}): SessionContext {
	const turns = overrides.turns ?? defaultTurns();
	const usageRows = overrides.usage ?? defaultUsage();

	const withTokens = turns.map((t) =>
		t.tokens !== 0
			? t
			: { ...t, tokens: usageRows.filter((u) => u.turnSeq === t.seq).reduce((n, u) => n + costTokensOf(u), 0) },
	);
	const sum = (k: "input" | "output" | "cacheCreation" | "cacheRead") => usageRows.reduce((n, u) => n + u[k], 0);
	const totals = overrides.totals ?? {
		input: sum("input"),
		output: sum("output"),
		cacheCreation: sum("cacheCreation"),
		cacheRead: sum("cacheRead"),
		tokens: usageRows.reduce((n, u) => n + costTokensOf(u), 0),
	};
	const first = withTokens[0]?.startedAt ?? at(0);
	const last = withTokens.at(-1)?.endedAt ?? at(30);
	return {
		session: {
			sessionId: "sess-1",
			startedAt: first,
			endedAt: last,
			cwd: "/r",
			repoId: "github.com/me/r",
			headEnd: null,
			sessionType: null,
			...overrides.session,
		},
		capture: overrides.capture ?? "hooks",
		turns: withTokens,
		toolCalls: overrides.toolCalls ?? [],
		usage: usageRows,
		totals,
		permissionRequests: overrides.permissionRequests ?? [],
		compactions: overrides.compactions ?? [],
		subagents: overrides.subagents ?? [],
		fileChanges: overrides.fileChanges ?? [],
		inventory: overrides.inventory ?? [],
		userMedianCacheShare: overrides.userMedianCacheShare === undefined ? null : overrides.userMedianCacheShare,
	};
}

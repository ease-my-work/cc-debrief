// Coaching contract (architecture "src/coach/types.ts", features 07 and 09).
import type { Db } from "../db/adapter";

export type Severity = "low" | "medium" | "high";

/**
 * One finding from a signal or digest rule. `evidence.key` names the subject (tool key, file, skill, server, day)
 * and becomes `findings.subject_key`; `target` is stored as `evidence.target`. Session-less (digest-rule) findings put
 * their subject repo in `evidence.repoId`.
 */
export type Finding = {
	rule: string;
	severity: Severity;
	message: string;
	evidence: Record<string, unknown>;
	costTokens: number;
	target: "session" | "skills" | "repos" | "overview";
	/** When it happened (ISO), stored as `created_at`; omitted = the session's last activity, or now without one. */
	at?: string;
};

export type ContextSession = {
	sessionId: string;
	startedAt: string | null;
	endedAt: string | null;
	cwd: string | null;
	repoId: string | null;
	headEnd: string | null;
	sessionType: string | null;
};

export type ContextTurn = {
	id: number;
	seq: number;
	userText: string | null;
	startedAt: string | null;
	endedAt: string | null;
	/** Non-cached tokens (input, cache writes, output) of the session's own usage rows for this turn (costTokensOf). */
	tokens: number;
};

export type ContextToolCall = {
	id: number;
	toolName: string;
	mcpServer: string | null;
	mcpSource: string | null;
	mcpTool: string | null;
	skillName: string | null;
	/** Decoded tool input; {} when missing or not an object. */
	input: Record<string, unknown>;
	ok: boolean | null;
	denied: string | null;
	exitCode: number | null;
	startedAt: string | null;
	endedAt: string | null;
	turnSeq: number | null;
	agentId: string | null;
	/** Bytes of the stored response plus N from a `…[truncated N bytes]` marker; loaded for `Read` calls only (0 else). */
	responseBytes: number;
};

export type ContextUsage = {
	turnSeq: number | null;
	agentId: string | null;
	ts: string | null;
	model: string | null;
	input: number;
	output: number;
	cacheCreation: number;
	cacheRead: number;
};

/** Per-column sums; `tokens` is the non-cached total (costTokensOf), the base of every "% of session tokens". */
export type ContextTotals = { input: number; output: number; cacheCreation: number; cacheRead: number; tokens: number };

export type ContextInventoryItem = {
	id: number;
	kind: "skill" | "plugin" | "mcp" | "hook";
	scope: "user" | "repo" | "plugin";
	repoId: string | null;
	name: string;
	description: string | null;
	meta: Record<string, unknown>;
	loaded: boolean;
	invoked: boolean;
};

export type SessionContext = {
	session: ContextSession;
	capture: "hooks" | "backfill";
	turns: ContextTurn[];
	toolCalls: ContextToolCall[];
	usage: ContextUsage[];
	totals: ContextTotals;
	/** `PermissionRequest` hook events of this session, oldest first. */
	permissionRequests: { tool: string; at: string; mcpServer: string | null }[];
	compactions: { at: string | null }[];
	subagents: { agentId: string; agentType: string | null; startedAt: string | null; endedAt: string | null }[];
	fileChanges: {
		toolCallId: number | null;
		path: string;
		repoId: string | null;
		linesAdded: number;
		linesRemoved: number;
	}[];
	/** Skills and MCP servers with an inventory_usage row for this session. */
	inventory: ContextInventoryItem[];
	/** Median cache share of the user's other sessions in the last 30 days; null with fewer than 5. */
	userMedianCacheShare: number | null;
};

export type Signal = { rule: string; detect(ctx: SessionContext): Finding[] };

/**
 * A feature 09 digest rule: reads the DB across sessions and returns session-less findings (subject repo in
 * `evidence.repoId`). Unlike a Signal, a rule needs the DB and a clock, not one session's context.
 */
export type DigestRule = { rule: string; run(db: Db, now: Date): Finding[] };

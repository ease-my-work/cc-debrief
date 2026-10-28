// GET /api/tools (feature 12): every built-in tool (no MCP server) ever called, with counts over sessions in the range
// and repo and its all-time last use, so a tool unused for a while still shows when it last ran (Phase 4 tuning).
import { toolCategory } from "../../derive/tool-categories";
import type { Range, ToolStat } from "../../server/types";
import type { Db } from "../adapter";
import { sessionScope } from "./inventory";
import { median, msBetween } from "./stats";

export function getToolStats(db: Db, q: { range: Range; repo?: string; now: Date }): ToolStat[] {
	const scope = sessionScope(q.range, q.repo, q.now);
	const by = new Map<
		string,
		{ calls: number; failures: number; denials: number; ms: number[]; sessions: Set<string>; last: string | null }
	>();
	for (const t of db
		.prepare("SELECT tool_name, max(started_at) AS last FROM tool_calls WHERE mcp_server IS NULL GROUP BY tool_name")
		.all<{ tool_name: string; last: string | null }>()) {
		by.set(t.tool_name, { calls: 0, failures: 0, denials: 0, ms: [], sessions: new Set<string>(), last: t.last });
	}
	for (const c of db
		.prepare(
			`SELECT tool_name, session_id, started_at, ended_at, ok, denied FROM tool_calls
			 WHERE mcp_server IS NULL AND session_id IN (${scope.sql})`,
		)
		.all<{
			tool_name: string;
			session_id: string;
			started_at: string | null;
			ended_at: string | null;
			ok: number | null;
			denied: string | null;
		}>(...scope.params)) {
		const t = by.get(c.tool_name);
		if (!t) continue;
		t.calls++;
		// Feature 03: a denied call (also ok = 0) is a denial, not a failure.
		if (c.denied !== null) t.denials++;
		else if (c.ok === 0) t.failures++;
		const ms = msBetween(c);
		if (ms !== null) t.ms.push(ms);
		t.sessions.add(c.session_id);
	}
	return [...by.entries()]
		.map(([name, t]) => ({
			name,
			calls: t.calls,
			failures: t.failures,
			denials: t.denials,
			medianMs: median(t.ms),
			sessions: t.sessions.size,
			lastUsed: t.last,
			category: toolCategory(name, null),
		}))
		.sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));
}

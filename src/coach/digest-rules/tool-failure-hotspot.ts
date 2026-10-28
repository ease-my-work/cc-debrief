// Digest rule 5, tool failure hotspot (feature 09; Phase 4 spec decision 6): the same tool key failing ≥ 3 times in
// one repo in the last 7 days. Key: `Bash: pytest` for shell tools (feature 07 command key), else the tool name.
import { decodePayload } from "../../ingest/line";
import { commandKey } from "../command-key";
import { SHELL_TOOLS } from "../signals/retry-loop";
import type { DigestRule, Finding } from "../types";
import { costTokensSql, daysBefore } from "./shared";

const MIN_FAILURES = 3;

function toolKey(toolName: string, input: Uint8Array | null): string {
	if (!SHELL_TOOLS.has(toolName) || !input) return toolName;
	try {
		const v = decodePayload(input) as { command?: unknown };
		const key = typeof v?.command === "string" ? commandKey(v.command) : "";
		return key ? `${toolName}: ${key}` : toolName;
	} catch {
		return toolName;
	}
}

export const toolFailureHotspot: DigestRule = {
	rule: "tool_failure_hotspot",
	run(db, now) {
		const rows = db
			.prepare(
				`SELECT c.session_id, c.turn_id, c.tool_name, c.input, s.repo_id, r.name AS repo_name
				 FROM tool_calls c JOIN sessions s ON s.session_id = c.session_id JOIN repos r ON r.repo_id = s.repo_id
				 WHERE c.ok = 0 AND c.denied IS NULL AND c.started_at >= ?`,
			)
			.all<{
				session_id: string;
				turn_id: number | null;
				tool_name: string;
				input: Uint8Array | null;
				repo_id: string;
				repo_name: string;
			}>(daysBefore(now, 7));
		const groups = new Map<string, { repoId: string; repoName: string; tool: string; rows: typeof rows }>();
		for (const r of rows) {
			const tool = toolKey(r.tool_name, r.input);
			const id = `${r.repo_id}|${tool}`;
			const g = groups.get(id) ?? { repoId: r.repo_id, repoName: r.repo_name, tool, rows: [] };
			g.rows.push(r);
			groups.set(id, g);
		}
		// Non-cached tokens per turn, read once per session through usage_session (usage has no turn_id index).
		const perSession = db.prepare(
			`SELECT turn_id, sum(${costTokensSql()}) AS n
			 FROM usage WHERE session_id = ? AND turn_id IS NOT NULL GROUP BY turn_id`,
		);
		const turnTokens = new Map<number, number>();
		for (const id of new Set(rows.map((r) => r.session_id))) {
			for (const t of perSession.all<{ turn_id: number; n: number }>(id)) turnTokens.set(t.turn_id, t.n);
		}
		const out: Finding[] = [];
		for (const [key, g] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
			const count = g.rows.length;
			if (count < MIN_FAILURES) continue;
			const turns = new Set(g.rows.map((r) => r.turn_id).filter((t): t is number => t !== null));
			let cost = 0;
			for (const t of turns) cost += turnTokens.get(t) ?? 0;
			out.push({
				rule: this.rule,
				severity: "low",
				message: `\`${g.tool}\` failed ${count} times in \`${g.repoName}\` this week`,
				evidence: {
					key,
					tool: g.tool,
					repoId: g.repoId,
					count,
					sessions: [...new Set(g.rows.map((r) => r.session_id))].sort(),
				},
				costTokens: cost,
				target: "repos",
			});
		}
		return out;
	},
};

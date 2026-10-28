// Signal 7, permission friction: ≥ 8 PermissionRequest hook events for one tool in a session (feature 07 row 7,
// detail 7). Hook-captured sessions only: imported sessions have no hook events.
import type { Finding, Signal } from "../types";

const MIN_PROMPTS = 8;
const MEDIUM_PROMPTS = 15;

export const permissionFriction: Signal = {
	rule: "permission_friction",
	detect(ctx) {
		if (ctx.capture !== "hooks") return [];
		const byTool = new Map<string, { count: number; mcpServer: string | null; at: string[] }>();
		for (const p of ctx.permissionRequests) {
			const g = byTool.get(p.tool) ?? { count: 0, mcpServer: p.mcpServer, at: [] };
			g.count++;
			g.at.push(p.at);
			byTool.set(p.tool, g);
		}
		const out: Finding[] = [];
		for (const [tool, g] of byTool) {
			if (g.count < MIN_PROMPTS) continue;
			const calls = ctx.toolCalls.filter((c) => c.toolName === tool);
			// Wait = request to the result of the next call of that tool (each call answers one request).
			const used = new Set<number>();
			let waitMs = 0;
			for (const when of g.at) {
				const t = Date.parse(when);
				const next = calls.find((c) => !used.has(c.id) && c.endedAt !== null && Date.parse(c.endedAt) >= t);
				if (!next?.endedAt) continue;
				used.add(next.id);
				waitMs += Date.parse(next.endedAt) - t;
			}
			const name = g.mcpServer ? `${tool} (${g.mcpServer} MCP)` : tool;
			out.push({
				rule: this.rule,
				severity: g.count >= MEDIUM_PROMPTS ? "medium" : "low",
				message: `${g.count} prompts for ${name} — consider a permission allowlist`,
				evidence: { key: tool, tool, count: g.count, denied: calls.filter((c) => c.denied).length, waitMs },
				costTokens: 0,
				target: "session",
			});
		}
		return out;
	},
};

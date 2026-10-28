// Signal 3, MCP bypassed: a loaded MCP server and a shell command doing its job by hand (feature 07 row 3, detail 3).
import { commandKey } from "../command-key";
import type { ContextInventoryItem, Finding, Signal } from "../types";
import { SHELL_TOOLS } from "./retry-loop";

const MEDIUM_CALLS = 3;

/**
 * Feature 07 equivalence map: a server named like postgres (`postgres` or `pg` in the name) ↔ `psql`, `pg_dump`;
 * `github` ↔ `gh` and curl/wget to api.github.com; any server with a URL ↔ curl/wget to the same host.
 */
export const MCP_EQUIVALENTS = {
	postgres: { match: (server: string) => /postgres|pg/i.test(server), commands: ["psql", "pg_dump"] },
	github: { match: (server: string) => /github/i.test(server), commands: ["gh"], hosts: ["api.github.com"] },
} as const;

const HTTP_TOOLS = new Set(["curl", "wget"]);

function hostOf(url: unknown): string | null {
	if (typeof url !== "string") return null;
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return null;
	}
}

/** Hosts named in a command's http(s) URLs. */
const commandHosts = (command: string): string[] =>
	[...command.matchAll(/https?:\/\/[^\s'"`]+/g)].map((m) => hostOf(m[0])).filter((h): h is string => h !== null);

/** The raw command (`psql`, `gh`, `curl`) a shell command uses in place of the server, or null. */
export function bypassCommand(command: string, server: { name: string; meta: Record<string, unknown> }): string | null {
	const exe = commandKey(command).split(" ")[0];
	if (!exe) return null;
	if (
		MCP_EQUIVALENTS.postgres.match(server.name) &&
		(MCP_EQUIVALENTS.postgres.commands as readonly string[]).includes(exe)
	)
		return exe;
	if (MCP_EQUIVALENTS.github.match(server.name)) {
		if (exe === "gh") return exe;
		if (HTTP_TOOLS.has(exe) && commandHosts(command).some((h) => h === "api.github.com")) return exe;
	}
	const host = hostOf(server.meta.url);
	if (host && HTTP_TOOLS.has(exe) && commandHosts(command).includes(host)) return exe;
	return null;
}

/** tool_calls.mcp_source of a server's calls: `plugin:<plugin>` for plugin servers, else null. */
const sourceOf = (item: ContextInventoryItem): string | null =>
	item.scope === "plugin" && typeof item.meta.plugin === "string" ? `plugin:${item.meta.plugin}` : null;

export const mcpBypassed: Signal = {
	rule: "mcp_bypassed",
	detect(ctx) {
		const out: Finding[] = [];
		for (const item of ctx.inventory) {
			if (item.kind !== "mcp" || !item.loaded) continue;
			const bypasses = ctx.toolCalls
				.filter((c) => SHELL_TOOLS.has(c.toolName) && !c.denied && typeof c.input.command === "string")
				.map((c) => ({ call: c, cmd: bypassCommand(c.input.command as string, item) }))
				.filter((b): b is { call: (typeof ctx.toolCalls)[number]; cmd: string } => b.cmd !== null);
			if (bypasses.length === 0) continue;
			// The user may have fallen back to the raw command because the server was failing.
			const firstAt = bypasses[0].call.startedAt ?? "";
			const source = sourceOf(item);
			const serverFailedFirst = ctx.toolCalls.some(
				(c) =>
					c.mcpServer === item.name &&
					c.mcpSource === source &&
					c.ok === false &&
					!c.denied &&
					(c.startedAt ?? "") < firstAt,
			);
			if (serverFailedFirst) continue;

			const count = bypasses.length;
			const commands = [...new Set(bypasses.map((b) => b.cmd))];
			const perTurn = new Map<number, number>();
			for (const b of bypasses)
				if (b.call.turnSeq !== null) perTurn.set(b.call.turnSeq, (perTurn.get(b.call.turnSeq) ?? 0) + 1);
			let cost = 0;
			for (const [seq, n] of perTurn) {
				const total = ctx.toolCalls.filter((c) => c.turnSeq === seq).length;
				const tokens = ctx.turns.find((t) => t.seq === seq)?.tokens ?? 0;
				cost += (tokens * n) / total;
			}
			const command = commands.join("/");
			out.push({
				rule: this.rule,
				severity: count >= MEDIUM_CALLS ? "medium" : "low",
				message: `Raw ${command} used ${count} ${count === 1 ? "time" : "times"}; the ${item.name} MCP was available`,
				evidence: {
					key: item.name,
					server: item.name,
					command,
					count,
					turns: [...perTurn.keys()].sort((a, b) => a - b),
				},
				costTokens: Math.round(cost),
				target: "skills",
			});
		}
		return out;
	},
};

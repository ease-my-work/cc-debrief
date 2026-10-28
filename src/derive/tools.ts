// Tool-name parsing (feature 03): MCP server / source / tool and Skill names, and exit codes of failed shell calls.

export type ParsedToolName = {
	mcpServer: string | null;
	mcpSource: string | null; // "plugin:<plugin>" | "claude.ai" | null
	mcpTool: string | null;
	skillName: string | null;
};

const NONE: ParsedToolName = { mcpServer: null, mcpSource: null, mcpTool: null, skillName: null };

function mcp(name: string): ParsedToolName {
	const rest = name.slice("mcp__".length);
	const cut = rest.indexOf("__");
	const middle = cut === -1 ? rest : rest.slice(0, cut);
	const mcpTool = cut === -1 ? null : rest.slice(cut + 2);
	if (middle.startsWith("plugin_")) {
		// plugin_<plugin>_<server>: the plugin name is the text up to the first "_" (feature 03).
		const inner = middle.slice("plugin_".length);
		const sep = inner.indexOf("_");
		const plugin = sep === -1 ? inner : inner.slice(0, sep);
		const server = sep === -1 ? inner : inner.slice(sep + 1);
		return { ...NONE, mcpServer: server, mcpSource: `plugin:${plugin}`, mcpTool };
	}
	if (middle.startsWith("claude_ai_")) {
		return { ...NONE, mcpServer: middle.slice("claude_ai_".length), mcpSource: "claude.ai", mcpTool };
	}
	return { ...NONE, mcpServer: middle, mcpTool };
}

function skillName(input: unknown): string | null {
	if (typeof input !== "object" || input === null) return null;
	const o = input as Record<string, unknown>;
	if (typeof o.skill === "string") return o.skill;
	if (typeof o.skill_name === "string") return o.skill_name;
	for (const [k, v] of Object.entries(o)) if (typeof v === "string" && k.toLowerCase().endsWith("skill")) return v;
	return null;
}

/** Parsed MCP and Skill fields; all null for other tools. attribution* overrides are applied in derive. */
export function parseToolName(toolName: string, toolInput: unknown): ParsedToolName {
	if (toolName.startsWith("mcp__")) return mcp(toolName);
	if (toolName === "Skill") return { ...NONE, skillName: skillName(toolInput) };
	return NONE;
}

/** N from a result starting "Exit code N" (failed Bash / PowerShell, Phase 0 A5); the first text block of an array. */
export function exitCodeFrom(resultContent: unknown): number | null {
	let text: unknown = resultContent;
	if (Array.isArray(resultContent)) {
		text = resultContent.find((b) => typeof b === "object" && b !== null && b.type === "text")?.text;
	}
	if (typeof text !== "string") return null;
	const m = /^Exit code (\d+)/.exec(text);
	return m ? Number(m[1]) : null;
}

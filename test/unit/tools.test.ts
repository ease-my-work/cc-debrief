import { describe, expect, it } from "vitest";
import { languageFor } from "../../src/derive/language";
import { exitCodeFrom, parseToolName } from "../../src/derive/tools";
import { fixtureLines } from "../helpers/fixtures";

const none = { mcpServer: null, mcpSource: null, mcpTool: null, skillName: null };

describe("parseToolName", () => {
	it("parses a plain MCP server name", () => {
		expect(parseToolName("mcp__github__search_code", {})).toEqual({
			mcpServer: "github",
			mcpSource: null,
			mcpTool: "search_code",
			skillName: null,
		});
	});

	it("parses plugin and claude.ai connector forms", () => {
		expect(parseToolName("mcp__plugin_context7_context7__query-docs", {})).toEqual({
			...none,
			mcpServer: "context7",
			mcpSource: "plugin:context7",
			mcpTool: "query-docs",
		});
		expect(parseToolName("mcp__claude_ai_Context7__query-docs", {})).toEqual({
			...none,
			mcpServer: "Context7",
			mcpSource: "claude.ai",
			mcpTool: "query-docs",
		});
	});

	it("splits on the first __ after the prefix", () => {
		expect(parseToolName("mcp__my__srv__tool", {})).toMatchObject({ mcpServer: "my", mcpTool: "srv__tool" });
	});

	it("takes the plugin name up to the first _ and handles a missing tool part", () => {
		expect(parseToolName("mcp__plugin_my_srv_x__t", {})).toMatchObject({ mcpServer: "srv_x", mcpSource: "plugin:my" });
		expect(parseToolName("mcp__lonely", {})).toMatchObject({ mcpServer: "lonely", mcpTool: null });
	});

	it("reads the skill name from every Skill call in the Phase 0 fixtures", () => {
		const inputs = fixtureLines()
			.filter(({ label }) => label.startsWith("transcripts"))
			.flatMap(({ raw }) => {
				const content = JSON.parse(raw).message?.content;
				return Array.isArray(content) ? content.filter((b) => b?.type === "tool_use" && b.name === "Skill") : [];
			})
			.map((b) => b.input);
		expect(inputs.length).toBeGreaterThan(0);
		for (const input of inputs) expect(parseToolName("Skill", input).skillName).toBe(input.skill);
	});

	it("falls back to skill_name, then any string field ending in skill", () => {
		expect(parseToolName("Skill", { skill_name: "b" }).skillName).toBe("b");
		expect(parseToolName("Skill", { args: "x", someSkill: "c" }).skillName).toBe("c");
		expect(parseToolName("Skill", { args: "x" }).skillName).toBeNull();
		expect(parseToolName("Skill", null).skillName).toBeNull();
	});

	it("returns all nulls for other tools", () => {
		expect(parseToolName("Bash", { command: "ls" })).toEqual(none);
		expect(parseToolName("mcpish", {})).toEqual(none);
	});
});

describe("exitCodeFrom", () => {
	it.each([
		["Exit code 1\n> test\n> exit 1", 1],
		["Exit code 127", 127],
		["ok", null],
		["Error: Exit code 1", null],
		[[{ type: "text", text: "Exit code 2\nboom" }], 2],
		[[{ type: "image" }, { type: "text", text: "Exit code 3" }], 3],
		[{}, null],
		[null, null],
	])("%j → %s", (content, code) => {
		expect(exitCodeFrom(content)).toBe(code);
	});
});

describe("languageFor", () => {
	it.each([
		["a/B.TSX", "tsx"],
		["src/hello.ts", "ts"],
		["C:\\r\\x.PY", "py"],
		["lib/a.mjs", "js"],
		["ci.yml", "yaml"],
		["Makefile", null],
		["archive.tar.gz", null],
		[".bashrc", null],
	])("%s → %s", (path, lang) => {
		expect(languageFor(path)).toBe(lang);
	});
});

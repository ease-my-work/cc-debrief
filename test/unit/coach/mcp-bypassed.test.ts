import { describe, expect, it } from "vitest";
import { bypassCommand, mcpBypassed } from "../../../src/coach/signals/mcp-bypassed";
import type { ContextToolCall } from "../../../src/coach/types";
import { at, call, ctx, mcp, usage } from "../../helpers/ctx";

const bash = (command: string, turn: number, o: { ok?: boolean; tool?: string; denied?: string } = {}) =>
	call(o.tool ?? "Bash", { command }, { turn, ok: o.ok ?? true, denied: o.denied ?? null });

function session(calls: ContextToolCall[], items = [mcp("postgres")]) {
	const rows = Array.from({ length: 10 }, (_, i) => usage(i + 1, { input: 1000 }));
	return ctx({ toolCalls: calls, usage: rows, inventory: items });
}

describe("bypassCommand", () => {
	const server = (name: string, meta: Record<string, unknown> = {}) => ({ name, meta });
	it.each([
		["psql -c 'select 1'", server("postgres"), "psql"],
		["pg_dump mydb", server("my-pg"), "pg_dump"],
		["gh pr list", server("github"), "gh"],
		["curl https://api.github.com/repos/x/y", server("github"), "curl"],
		["wget -q https://api.github.com/x", server("github"), "wget"],
		["curl https://mcp.example.com/y", server("tracker", { url: "https://mcp.example.com/x" }), "curl"],
		["curl https://other.example.com/y", server("tracker", { url: "https://mcp.example.com/x" }), null],
		["curl https://example.com", server("github"), null],
		["psql -c x", server("github"), null],
		["npm test", server("postgres"), null],
	])("%s with %o → %s", (command, s, expected) => {
		expect(bypassCommand(command, s)).toBe(expected);
	});
});

describe("mcp_bypassed", () => {
	it("fires once with singular wording for one raw psql call", () => {
		const c = session([bash("psql -c 'select count(*) from t'", 2), call("Read", { file_path: "a" }, { turn: 2 })]);
		expect(mcpBypassed.detect(c)).toEqual([
			{
				rule: "mcp_bypassed",
				severity: "low",
				message: "Raw psql used 1 time; the postgres MCP was available",
				evidence: { key: "postgres", server: "postgres", command: "psql", count: 1, turns: [2] },
				// turn 2 has 1000 tokens and 1 bypass call of 2 tool calls
				costTokens: 500,
				target: "skills",
			},
		]);
	});

	it("leaves cache reads out of the cost", () => {
		const rows = Array.from({ length: 10 }, (_, i) => usage(i + 1, { input: 1000, cacheRead: 9000 }));
		const c = ctx({ toolCalls: [bash("psql -c a", 2)], usage: rows, inventory: [mcp("postgres")] });
		expect(mcpBypassed.detect(c)[0].costTokens).toBe(1000);
	});

	it("is medium at 3 calls, plural wording, PowerShell counted", () => {
		const c = session([bash("psql -c a", 1), bash("psql -c b", 2, { tool: "PowerShell" }), bash("psql -c c", 3)]);
		const [f] = mcpBypassed.detect(c);
		expect(f.severity).toBe("medium");
		expect(f.message).toBe("Raw psql used 3 times; the postgres MCP was available");
		expect(f.costTokens).toBe(3000);
	});

	it("fires for github with gh and with curl to api.github.com", () => {
		expect(mcpBypassed.detect(session([bash("gh pr list", 1)], [mcp("github")]))).toHaveLength(1);
		const [f] = mcpBypassed.detect(
			session([bash("curl https://api.github.com/repos", 1), bash("gh issue list", 2)], [mcp("github")]),
		);
		expect(f.evidence).toMatchObject({ command: "curl/gh", count: 2 });
	});

	it("fires for a URL server on curl to the same host", () => {
		const items = [mcp("tracker", { url: "https://mcp.example.com/x" })];
		expect(mcpBypassed.detect(session([bash("curl https://mcp.example.com/y", 1)], items))).toHaveLength(1);
	});

	it("does not fire when a call to the same server failed before the first bypass", () => {
		const failed = call("mcp__postgres__query", {}, { turn: 1, ok: false, mcp: { server: "postgres" }, at: at(0, 10) });
		expect(mcpBypassed.detect(session([failed, bash("psql -c x", 2)]))).toEqual([]);
		// a failure of a plugin server with the same name does not count
		const other = call(
			"mcp__plugin_db_postgres__query",
			{},
			{
				turn: 1,
				ok: false,
				mcp: { server: "postgres", source: "plugin:db" },
				at: at(0, 10),
			},
		);
		expect(mcpBypassed.detect(session([other, bash("psql -c x", 2)]))).toHaveLength(1);
	});

	it("does not fire when the server was not loaded or the call was denied", () => {
		expect(mcpBypassed.detect(session([bash("psql -c x", 1)], [mcp("postgres", { loaded: false })]))).toEqual([]);
		expect(mcpBypassed.detect(session([bash("psql -c x", 1)], []))).toEqual([]);
		expect(mcpBypassed.detect(session([bash("psql -c x", 1, { ok: false, denied: "user" })]))).toEqual([]);
	});
});

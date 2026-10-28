import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../src/db/adapter";
import { getInventory } from "../../src/db/queries/inventory";
import { getToolStats } from "../../src/db/queries/tools";
import { createApp } from "../../src/server/app";
import type { InventoryResponse, ToolsResponse } from "../../src/server/types";
import { seedDb } from "../helpers/seed";
import { at, REPO_APP, S, S7, SMALL_NOW, seedSmall, seedSmallInventory } from "../helpers/seed-small";
import { type TmpHome, tmpHome } from "../helpers/tmp-home";

let h: TmpHome;
let db: Db;
beforeEach(() => {
	h = tmpHome();
	db = seedDb();
	seedSmall(db);
	seedSmallInventory(db);
	// Routes read the real clock: pin it to the fixture's NOW so range windows stay put.
	vi.useFakeTimers({ now: SMALL_NOW, toFake: ["Date"] });
});
afterEach(() => {
	vi.useRealTimers();
	db.close();
	h.cleanup();
});

const inv = (q: Partial<Parameters<typeof getInventory>[1]> = {}) =>
	getInventory(db, { kind: "skill", range: "30d", now: SMALL_NOW, ...q });

describe("getInventory: skills", () => {
	it("computes the summary strip", () => {
		expect(inv().strip).toEqual({
			installed: 6,
			byScope: { user: 2, plugin: 1, repo: 3 },
			invoked: 2,
			neverInvoked: 3,
			// Sessions with loaded rows: S1 25, S2 25, S3 20, S5 0 tokens of non-active skills → 17.5.
			unusedCtxTokensPerSession: 18,
		});
	});

	it("lists items sorted by sessions loaded with counts, status and context cost", () => {
		const rows = inv().items.map((i) => [
			i.name,
			i.source,
			i.scope,
			i.sessionsLoaded,
			i.sessionsInvoked,
			i.status,
			i.ctxTokens,
			i.removed,
		]);
		expect(rows).toEqual([
			["code-review", "user", "user", 4, 1, "active", 10, false],
			["deploy", "app/.claude/skills", "repo", 3, 1, "active", 4, false],
			["superpowers:brainstorming", "superpowers", "plugin", 3, 0, "never_used", 20, false],
			["old-helper", "user", "user", 2, 0, "unused_30d", 2, false],
			["apihelp", "api/.claude/skills", "repo", 1, 0, "never_used", 3, false],
			["demo", "app/.claude/skills", "repo", 1, 0, "never_used", 3, false],
			["gone", "user", "user", 0, 0, "never_used", 1, true],
		]);
		const byName = Object.fromEntries(inv().items.map((i) => [i.name, i]));
		expect(byName["code-review"].lastUsed).toBe(at(10, 1, 10));
		expect(byName["old-helper"].lastUsed).toBe(at(8, 23, 10));
		expect(byName.demo.lastUsed).toBeNull();
		expect(byName["code-review"].path).toBe("/p/code-review");
	});

	it("filters to non-active items with unused", () => {
		expect(inv({ unused: true }).items.map((i) => i.name)).toEqual([
			"superpowers:brainstorming",
			"old-helper",
			"apihelp",
			"demo",
			"gone",
		]);
	});

	it("marks a skill invoked only 40 days ago as unused_30d, even in the 7-day range", () => {
		expect(inv({ range: "7d" }).items.find((i) => i.name === "old-helper")?.status).toBe("unused_30d");
		db.prepare("DELETE FROM inventory_usage WHERE session_id = ?").run(S7);
		expect(inv().items.find((i) => i.name === "old-helper")?.status).toBe("never_used");
	});

	it("limits items and counts to the repo filter", () => {
		const r = inv({ repo: REPO_APP });
		expect(r.items.map((i) => [i.name, i.sessionsLoaded])).toEqual([
			["code-review", 3],
			["deploy", 3],
			["superpowers:brainstorming", 2],
			["demo", 1],
			["old-helper", 1],
			["gone", 0],
		]);
		expect(r.strip.byScope).toEqual({ user: 2, plugin: 1, repo: 2 });
	});
});

describe("getInventory: MCP, plugins and hooks", () => {
	it("lists MCP servers with tools, calls, failures and median ms, and claude.ai connectors from calls", () => {
		const items = inv({ kind: "mcp" }).items;
		expect(
			items.map((i) => [i.name, i.source, i.sessionsLoaded, i.status, i.tools, i.calls, i.failures, i.medianMs]),
		).toEqual([
			["github", "user", 2, "active", 1, 1, 0, 1800],
			["Notion", "claude.ai", 1, "active", 1, 1, 0, 3000],
			["tracker", "app/.mcp.json", 1, "never_used", 0, 0, 0, undefined],
		]);
		expect(items.find((i) => i.name === "Notion")?.id).toBeLessThan(0);
	});

	const mcpCall = (server: string, source: string | null, tool: string) =>
		db
			.prepare(
				`INSERT INTO tool_calls (session_id, tool_use_id, tool_name, mcp_server, mcp_source, mcp_tool, started_at, ended_at, ok)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
			)
			.run(
				S.s1,
				`tu-${server}-${tool}`,
				`mcp__${server}__${tool}`,
				server,
				source,
				tool,
				at(10, 1, 10, 6),
				at(10, 1, 10, 6, 1),
			);

	it("counts calls to a server whatever the case of its name", () => {
		mcpCall("GitHub", null, "list_issues");
		const github = inv({ kind: "mcp" }).items.filter((i) => i.name.toLowerCase() === "github");
		expect(github.map((i) => [i.name, i.calls, i.tools])).toEqual([["github", 2, 2]]);
	});

	it("lists a called server that has no inventory row instead of dropping its calls", () => {
		mcpCall("localdb", null, "query");
		const row = inv({ kind: "mcp" }).items.find((i) => i.name === "localdb");
		expect(row).toMatchObject({ source: "no config found", scope: "user", path: "", calls: 1, status: "active" });
		expect(row?.id).toBeLessThan(0);
	});

	it("counts a plugin's MCP servers in what it provides and in its usage", () => {
		const add = db.prepare(
			`INSERT INTO inventory (scope, repo_id, kind, name, path, first_seen, last_seen, meta)
			 VALUES ('plugin', NULL, ?, 'context7', '/p/context7', ?, ?, ?) RETURNING id`,
		);
		const seen = at(10, 2, 8);
		add.get("plugin", seen, seen, JSON.stringify({ enabled: true }));
		const server = add.get<{ id: number }>("mcp", seen, seen, JSON.stringify({ plugin: "context7" }));
		db.prepare("INSERT INTO inventory_usage (inventory_id, session_id, loaded, invoked) VALUES (?, ?, 1, 1)").run(
			server?.id,
			S.s1,
		);
		const plugin = inv({ kind: "plugin" }).items.find((p) => p.name === "context7");
		expect(plugin).toMatchObject({
			provides: "0 skills · 1 MCP server",
			sessionsLoaded: 1,
			sessionsInvoked: 1,
			status: "active",
		});
	});

	it("lists plugins with what they provide and hooks with their event, never our own hook", () => {
		const plugins = inv({ kind: "plugin" }).items;
		expect(plugins.map((p) => [p.name, p.sessionsLoaded, p.provides, p.enabled, p.status])).toEqual([
			["superpowers", 3, "1 skill", true, "never_used"],
			["oldtool", 0, "0 skills", false, "never_used"],
		]);
		const hooks = inv({ kind: "hook" }).items;
		expect(hooks.map((x) => [x.name, x.provides, x.sessionsLoaded, x.status])).toEqual([
			["Stop: echo hi", "Stop", 0, "active"],
		]);
		expect(JSON.stringify(hooks)).not.toContain("cc-debrief");
	});
});

describe("getToolStats", () => {
	it("lists built-in tools with calls, failures, denials, medians (even and odd counts), sessions and last use", () => {
		const tools = getToolStats(db, { range: "30d", now: SMALL_NOW });
		// The denied Write is a denial, not a failure (feature 03).
		expect(tools.map((t) => [t.name, t.calls, t.failures, t.denials, t.medianMs, t.sessions])).toEqual([
			["Grep", 3, 0, 0, 1000, 2],
			["Bash", 2, 1, 0, 1500, 1],
			["Agent", 1, 0, 0, 60000, 1],
			["Read", 1, 0, 0, 1000, 1],
			["Skill", 1, 0, 0, 100, 1],
			["Write", 1, 0, 1, 5000, 1],
		]);
		expect(tools.find((t) => t.name === "Grep")?.lastUsed).toBe(at(10, 1, 10, 5, 20));
		expect(tools.some((t) => t.name.startsWith("mcp__"))).toBe(false);
	});

	it("counts within the range but lists every tool ever called, with its all-time last use", () => {
		// The tool calls belong to s1 (1 Oct) and s2 (30 Sep); "today" is 2 Oct from local midnight.
		const today = getToolStats(db, { range: "today", now: SMALL_NOW });
		expect(today.map((t) => [t.name, t.calls, t.sessions, t.medianMs])).toEqual(
			["Agent", "Bash", "Grep", "Read", "Skill", "Write"].map((n) => [n, 0, 0, null]),
		);
		expect(today.find((t) => t.name === "Grep")?.lastUsed).toBe(at(10, 1, 10, 5, 20));
		expect(getToolStats(db, { range: "7d", now: SMALL_NOW }).find((t) => t.name === "Grep")?.calls).toBeGreaterThan(0);
	});

	it("counts only the repo's sessions under the repo filter", () => {
		const tools = getToolStats(db, { range: "30d", repo: "github.com/me/api", now: SMALL_NOW });
		expect(tools.filter((t) => t.calls > 0).map((t) => t.name)).toEqual(["Grep"]);
		expect(tools).toHaveLength(6);
	});
});

describe("inventory routes", () => {
	const get = (path: string) =>
		createApp(db, { port: 4242, uiDir: "/x" }).request(path, { headers: { host: "localhost:4242" } });

	it("GET /api/inventory defaults to skills over 30 days", async () => {
		const r = await get("/api/inventory");
		expect(r.status).toBe(200);
		expect(((await r.json()) as InventoryResponse).items.length).toBe(7);
		expect(((await (await get("/api/inventory?unused=1")).json()) as InventoryResponse).items.length).toBe(5);
	});

	it("GET /api/tools returns ToolStats", async () => {
		const body = (await (await get("/api/tools")).json()) as ToolsResponse;
		expect(body.tools[0].name).toBe("Grep");
	});

	it("rejects bad parameters with 400", async () => {
		for (const q of ["kind=theme", "range=1y", "unused=maybe"])
			expect((await get(`/api/inventory?${q}`)).status, q).toBe(400);
		expect((await get("/api/tools?range=1y")).status).toBe(400);
	});
});

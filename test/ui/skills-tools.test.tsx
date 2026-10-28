import type { InventoryItemRow, InventoryResponse, ToolsResponse } from "@api-types";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../ui/src/app";
import { at, mockFetch, route, statusFixture } from "./helpers";

const row = (id: number, name: string, over: Partial<InventoryItemRow> = {}): InventoryItemRow => ({
	id,
	name,
	source: "user",
	scope: "user",
	path: `/home/me/.claude/skills/${name}`,
	sessionsLoaded: 42,
	sessionsInvoked: 0,
	lastUsed: null,
	ctxTokens: 480,
	status: "never_used",
	removed: false,
	...over,
});

const strip = {
	installed: 18,
	byScope: { user: 6, plugin: 9, repo: 3 },
	invoked: 9,
	neverInvoked: 7,
	unusedCtxTokensPerSession: 3100,
};
const skills: InventoryResponse = {
	strip,
	items: [
		row(1, "pdf", { source: "anthropic-skills", scope: "plugin" }),
		row(2, "code-review", {
			sessionsInvoked: 14,
			lastUsed: new Date().toISOString(),
			status: "active",
			ctxTokens: 300,
		}),
		row(3, "old-helper", { sessionsInvoked: 0, status: "unused_30d", removed: true }),
	],
};
const mcp: InventoryResponse = {
	strip: { ...strip, installed: 3 },
	items: [
		row(10, "github", { tools: 12, calls: 31, failures: 2, medianMs: 1800, status: "active", ctxTokens: 0 }),
		row(-1, "Notion", {
			source: "claude.ai",
			path: "",
			tools: 2,
			calls: 4,
			failures: 0,
			medianMs: 900,
			status: "active",
		}),
	],
};
const plugins: InventoryResponse = {
	strip: { ...strip, installed: 2 },
	items: [
		row(20, "superpowers", {
			scope: "plugin",
			provides: "14 skills",
			enabled: true,
			sessionsLoaded: 40,
			status: "active",
		}),
	],
};
const hooks: InventoryResponse = {
	strip: { ...strip, installed: 1 },
	items: [
		row(30, "Stop: make fmt", {
			provides: "Stop",
			sessionsLoaded: 0,
			status: "active",
			path: "/home/me/.claude/settings.json",
		}),
	],
};
const tools: ToolsResponse = {
	tools: [
		{
			name: "Grep",
			calls: 120,
			failures: 3,
			denials: 1,
			medianMs: 410,
			sessions: 31,
			lastUsed: new Date().toISOString(),
			category: "search",
		},
	],
};

let log: URL[];
let empty = false;
let firstRun = false;
let noPlugins = false;
/** Requests that answer 500: a path, or "/api/inventory?kind=<kind>". */
let failing = new Set<string>();
beforeEach(() => {
	empty = false;
	firstRun = false;
	noPlugins = false;
	failing = new Set();
	log = mockFetch([
		(u) => {
			const k = u.pathname === "/api/inventory" ? `${u.pathname}?kind=${u.searchParams.get("kind")}` : u.pathname;
			return failing.has(k) ? { status: 500, body: { error: { code: "internal", message: "boom" } } } : undefined;
		},
		route("/api/status", () => statusFixture(firstRun ? { lastIngestAt: null } : {})),
		route("/api/repos", { repos: [] }),
		route("/api/tools", tools),
		route("/api/inventory", (u: URL) => {
			if (empty)
				return {
					strip: {
						...strip,
						installed: 0,
						invoked: 0,
						neverInvoked: 0,
						unusedCtxTokensPerSession: 0,
						byScope: { user: 0, plugin: 0, repo: 0 },
					},
					items: [],
				};
			const kind = u.searchParams.get("kind") ?? "skill";
			if (kind === "plugin" && noPlugins) return { strip: { ...strip, installed: 0 }, items: [] };
			return { skill: skills, mcp, plugin: plugins, hook: hooks }[kind];
		}),
	]);
});
afterEach(() => vi.unstubAllGlobals());

const headers = () => screen.getAllByRole("columnheader").map((h) => h.textContent);

describe("Skills & Tools", () => {
	it("shows the strip and the skills table with its columns and footer note", async () => {
		at("/skills");
		render(<App />);
		expect(await screen.findByText("18 skills")).toBeTruthy();
		expect(screen.getByText("6 user · 9 plugin · 3 in repos")).toBeTruthy();
		expect(screen.getByText("at least once in 30 days")).toBeTruthy();
		expect(screen.getByText("still loaded into every session")).toBeTruthy();
		expect(screen.getByText("~3.1k")).toBeTruthy();
		expect(headers()).toEqual([
			"Skill",
			"Scope",
			"Loaded",
			"Invoked",
			"Invoked / loaded",
			"Last used",
			"Ctx tokens",
			"Status",
			"",
		]);
		expect(screen.getByText("anthropic-skills")).toBeTruthy();
		expect(screen.getAllByText("~480").length).toBeGreaterThan(0);
		expect(
			screen.getByText(
				"Loaded = discovered at session start (its description is in context). Invoked = the Skill tool ran it. Ctx tokens is an estimate from the SKILL.md description length. Remove opens the file location; nothing is deleted automatically.",
			),
		).toBeTruthy();
	});

	it("colours status badges by status and marks removed items", async () => {
		at("/skills");
		render(<App />);
		await screen.findByText("pdf");
		expect(screen.getByText("never used").className).toMatch(/text-bad/);
		expect(screen.getByText("active").className).toMatch(/text-good/);
		expect(screen.getByText("unused 30d").className).toMatch(/text-amber/);
		expect(screen.getByText("removed")).toBeTruthy();
	});

	it("filters to unused items with the checkbox", async () => {
		at("/skills");
		render(<App />);
		await screen.findByText("pdf");
		await userEvent.click(screen.getByRole("checkbox", { name: "Show unused only" }));
		await waitFor(() =>
			expect(log.some((u) => u.pathname === "/api/inventory" && u.searchParams.get("unused") === "1")).toBe(true),
		);
		expect(new URLSearchParams(window.location.search).get("unused")).toBe("1");
	});

	it("opens a Remove popover with the path and a copy button, without any request", async () => {
		const writeText = vi.fn(async () => {});
		Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
		at("/skills");
		render(<App />);
		await screen.findByText("pdf");
		const before = log.length;
		await userEvent.click(screen.getAllByRole("button", { name: "Remove" })[0]);
		const dialog = screen.getByRole("dialog");
		expect(within(dialog).getByText("/home/me/.claude/skills/pdf")).toBeTruthy();
		await userEvent.click(within(dialog).getByRole("button", { name: "Copy path" }));
		expect(writeText).toHaveBeenCalledWith("/home/me/.claude/skills/pdf");
		expect(log.length).toBe(before);
		await userEvent.keyboard("{Escape}");
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("words Remove by kind: a skill folder, a plugin's item, an entry inside an MCP config file", async () => {
		at("/skills");
		render(<App />);
		await screen.findByText("code-review");
		const removeIn = async (name: string) => {
			const row = screen.getByText(name).closest("tr") as HTMLElement;
			await userEvent.click(within(row).getByRole("button", { name: "Remove" }));
			const text = screen.getByRole("dialog").textContent ?? "";
			await userEvent.keyboard("{Escape}");
			return text;
		};
		expect(await removeIn("code-review")).toMatch(/Delete this folder/);
		const plugin = await removeIn("pdf");
		expect(plugin).toMatch(/anthropic-skills plugin/);
		expect(plugin).not.toMatch(/Delete/);
	});

	it("never tells you to delete an MCP config file", async () => {
		at("/skills?tab=mcp");
		render(<App />);
		const row = (await screen.findByText("github")).closest("tr") as HTMLElement;
		await userEvent.click(within(row).getByRole("button", { name: "Remove" }));
		const text = screen.getByRole("dialog").textContent ?? "";
		expect(text).toMatch(/Remove the "github" entry from this file/);
		expect(text).not.toMatch(/Delete/);
	});

	it("shows the MCP columns and no Remove for a claude.ai connector", async () => {
		at("/skills?tab=mcp");
		render(<App />);
		expect(await screen.findByText("github")).toBeTruthy();
		expect(headers()).toEqual([
			"Server",
			"Scope",
			"Tools",
			"Calls",
			"Failures",
			"Median ms",
			"Last used",
			"Status",
			"",
		]);
		const notion = screen.getByText("Notion").closest("tr") as HTMLElement;
		expect(within(notion).queryByRole("button", { name: "Remove" })).toBeNull();
		expect(screen.getByText("3 MCP servers")).toBeTruthy();
	});

	it("shows the built-in tools columns", async () => {
		at("/skills?tab=tools");
		render(<App />);
		expect(await screen.findByText("Grep")).toBeTruthy();
		expect(headers()).toEqual([
			"Tool",
			"Category",
			"Calls",
			"Failures",
			"Denials",
			"Median ms",
			"Sessions",
			"Last used",
		]);
		expect(screen.getByText("410")).toBeTruthy();
	});

	it("shows plugins and hooks together", async () => {
		at("/skills?tab=plugins");
		render(<App />);
		expect(await screen.findByText("superpowers")).toBeTruthy();
		expect(screen.getByText("Stop: make fmt")).toBeTruthy();
		expect(headers()).toEqual(["Name", "Kind", "Scope", "Provides", "Sessions loaded", "Status"]);
		expect(screen.getByText("14 skills")).toBeTruthy();
	});

	it("switches tabs through the URL", async () => {
		at("/skills");
		render(<App />);
		await screen.findByText("pdf");
		await userEvent.click(screen.getByRole("tab", { name: "MCP servers" }));
		await waitFor(() => expect(new URLSearchParams(window.location.search).get("tab")).toBe("mcp"));
		expect(await screen.findByText("github")).toBeTruthy();
	});

	it("suggests cc-debrief scan when nothing is installed", async () => {
		empty = true;
		at("/skills");
		render(<App />);
		expect(await screen.findByText("cc-debrief scan")).toBeTruthy();
	});

	it("shows the first-run state before any session is captured", async () => {
		firstRun = true;
		at("/skills?tab=tools");
		render(<App />);
		expect(await screen.findByText("No sessions captured yet")).toBeTruthy();
		expect(screen.getByText("cc-debrief doctor")).toBeTruthy();
	});

	it("shows an error card with a working retry when the tools tab fails after the skills tab loaded", async () => {
		failing.add("/api/tools");
		at("/skills");
		render(<App />);
		await screen.findByText("pdf");
		await userEvent.click(screen.getByRole("tab", { name: "Built-in tools" }));
		expect(await screen.findByText("Could not load this panel")).toBeTruthy();
		failing.clear();
		await userEvent.click(screen.getByRole("button", { name: "Retry" }));
		expect(await screen.findByText("Grep")).toBeTruthy();
	});

	it("never shows one tab's rows in another tab's table while it loads or fails", async () => {
		failing.add("/api/inventory?kind=mcp");
		at("/skills");
		render(<App />);
		await screen.findByText("pdf");
		await userEvent.click(screen.getByRole("tab", { name: "MCP servers" }));
		expect(await screen.findByText("Could not load this panel")).toBeTruthy();
		expect(screen.queryByText("pdf")).toBeNull();
	});

	it("shows hooks when no plugin is installed", async () => {
		noPlugins = true;
		at("/skills?tab=plugins");
		render(<App />);
		expect(await screen.findByText("Stop: make fmt")).toBeTruthy();
		expect(screen.queryByText("Nothing installed found")).toBeNull();
		expect(screen.queryByText("Nothing unused in this range.")).toBeNull();
	});

	it("retries a failed hooks request from its own card", async () => {
		failing.add("/api/inventory?kind=hook");
		at("/skills?tab=plugins");
		render(<App />);
		expect(await screen.findByText("superpowers")).toBeTruthy();
		expect(await screen.findByText("Could not load this panel")).toBeTruthy();
		failing.clear();
		await userEvent.click(screen.getByRole("button", { name: "Retry" }));
		expect(await screen.findByText("Stop: make fmt")).toBeTruthy();
	});

	it("does not carry Show unused only into the Plugins tab, which has no such box", async () => {
		at("/skills?unused=1");
		render(<App />);
		await screen.findByText("pdf");
		await userEvent.click(screen.getByRole("tab", { name: "Plugins & hooks" }));
		expect(await screen.findByText("superpowers")).toBeTruthy();
		const pluginCalls = log.filter((u) => u.pathname === "/api/inventory" && u.searchParams.get("kind") === "plugin");
		expect(pluginCalls.length).toBeGreaterThan(0);
		expect(pluginCalls.some((u) => u.searchParams.has("unused"))).toBe(false);
	});
});

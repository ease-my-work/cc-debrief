// Phase 7 Task 12 (P10): Built-in tools tab — category column and filter, feature adoption, Claude Code versions.
import type { AdoptionResponse, ToolStat, VersionsResponse } from "@api-types";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../ui/src/app";
import { at, mockFetch, route, statusFixture } from "./helpers";

const tool = (name: string, category: ToolStat["category"], calls: number): ToolStat => ({
	name,
	calls,
	failures: 0,
	denials: 0,
	medianMs: null,
	sessions: 1,
	lastUsed: null,
	category,
});
const adoption: AdoptionResponse = {
	rows: [
		{ feature: "plan_mode", sessions: 2, share: 0.5 },
		{ feature: "subagents", sessions: 1, share: 0.25 },
		{ feature: "skills", sessions: 1, share: 0.25 },
		{ feature: "mcp", sessions: 0, share: 0 },
		{ feature: "web", sessions: 1, share: 0.25 },
		{ feature: "auto_mode", sessions: 3, share: 0.75 },
	],
};
const versions: VersionsResponse = {
	versions: [
		{ version: "2.1.299", firstSeen: "2026-10-10T10:00:00.000Z", lastSeen: "2026-10-17T10:00:00.000Z", sessions: 19 },
		{ version: "2.1.295", firstSeen: "2026-10-01T10:00:00.000Z", lastSeen: "2026-10-09T10:00:00.000Z", sessions: 24 },
	],
};

beforeEach(() => {
	at("/skills?tab=tools");
	mockFetch([
		route("/api/status", statusFixture()),
		route("/api/repos", { repos: [] }),
		route("/api/tools", {
			tools: [tool("Bash", "shell", 40), tool("Read", "file_read", 20), tool("TaskUpdate", "tasks_plans", 3)],
		}),
		route("/api/adoption", adoption),
		route("/api/versions", versions),
	]);
});
afterEach(() => vi.unstubAllGlobals());

describe("Built-in tools tab", () => {
	it("shows each tool's category and filters by it", async () => {
		render(<App />);
		const table = await screen.findByRole("table", { name: "Built-in tools" });
		expect(within(table).getByText("tasks & plans")).toBeTruthy();
		await userEvent.click(screen.getByRole("button", { name: "Shell" }));
		expect(within(table).getAllByRole("row")).toHaveLength(2); // header + Bash
		expect(within(table).getByText("Bash")).toBeTruthy();
		await userEvent.click(screen.getByRole("button", { name: "All" }));
		expect(within(table).getAllByRole("row")).toHaveLength(4);
	});

	it("shows feature adoption as a share of sessions", async () => {
		render(<App />);
		const t = within(await screen.findByRole("table", { name: "Feature adoption" }));
		expect(t.getByRole("row", { name: /Plan mode 2 50%/ })).toBeTruthy();
		expect(t.getByRole("row", { name: /Auto mode 3 75%/ })).toBeTruthy();
	});

	it("lists Claude Code versions newest first", async () => {
		render(<App />);
		const t = within(await screen.findByRole("table", { name: "Claude Code versions" }));
		const rows = t.getAllByRole("row").slice(1);
		expect(rows.map((r) => within(r).getAllByRole("cell")[0].textContent)).toEqual(["2.1.299", "2.1.295"]);
	});
});

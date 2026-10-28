// Phase 7 Task 13 (P11): the Workspace tab — agents, commands, output styles, rules and workflows.
import type { InventoryItemRow, InventoryResponse } from "@api-types";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../ui/src/app";
import { at, mockFetch, statusFixture } from "./helpers";

const item = (id: number, name: string, over: Partial<InventoryItemRow> = {}): InventoryItemRow => ({
	id,
	name,
	source: "user",
	scope: "user",
	path: `/home/u/.claude/agents/${name}.md`,
	sessionsLoaded: 3,
	sessionsInvoked: 2,
	lastUsed: new Date().toISOString(),
	ctxTokens: 0,
	status: "active",
	removed: false,
	usageRecorded: true,
	...over,
});
const response = (items: InventoryItemRow[]): InventoryResponse => ({
	strip: {
		installed: items.length,
		byScope: { user: items.length, plugin: 0, repo: 0 },
		invoked: 0,
		neverInvoked: 0,
		unusedCtxTokensPerSession: 0,
	},
	items,
});

let log: URL[];
beforeEach(() => {
	at("/skills?tab=workspace");
	log = mockFetch([
		(u) => (u.pathname === "/api/status" ? { body: statusFixture() } : undefined),
		(u) => (u.pathname === "/api/repos" ? { body: { repos: [] } } : undefined),
		(u) => {
			if (u.pathname !== "/api/inventory") return undefined;
			const kind = u.searchParams.get("kind");
			if (kind === "agent")
				return {
					body: response([item(1, "code-reviewer"), item(2, "never", { sessionsInvoked: 0, status: "never_used" })]),
				};
			if (kind === "output_style")
				return { body: response([item(3, "Terse", { usageRecorded: false, sessionsLoaded: 0, sessionsInvoked: 0 })]) };
			return { body: response([]) };
		},
	]);
});
afterEach(() => vi.unstubAllGlobals());

describe("Workspace tab", () => {
	it("lists agents first, with invocations and status", async () => {
		render(<App />);
		const table = within(await screen.findByRole("table", { name: "Agents" }));
		expect(table.getByText("code-reviewer")).toBeTruthy();
		expect(table.getByRole("row", { name: /never .* 0 .*never used/i })).toBeTruthy();
	});

	it("switches kinds, and says usage is not recorded for output styles", async () => {
		render(<App />);
		await screen.findByRole("table", { name: "Agents" });
		await userEvent.click(screen.getByRole("button", { name: "Output styles" }));
		await waitFor(() => expect(log.some((u) => u.searchParams.get("kind") === "output_style")).toBe(true));
		const table = within(await screen.findByRole("table", { name: "Output styles" }));
		expect(table.getByText("usage not recorded")).toBeTruthy();
	});

	it("an empty kind says none found", async () => {
		render(<App />);
		await screen.findByRole("table", { name: "Agents" });
		await userEvent.click(screen.getByRole("button", { name: "Workflows" }));
		expect(
			await screen.findByText("No workflows found in ~/.claude, your repos' .claude folders or plugins."),
		).toBeTruthy();
	});
});

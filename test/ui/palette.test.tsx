// Phase 7 Task 15 (P14): the Ctrl/Cmd-K command palette and keyboard navigation.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../ui/src/app";
import { at, mockFetch, route, sessionDetail, sessionItem, statusFixture } from "./helpers";

let log: URL[];
beforeEach(() => {
	log = mockFetch([
		route("/api/status", statusFixture()),
		(u) =>
			u.pathname === "/api/sessions"
				? {
						body: {
							items: u.searchParams.get("q")
								? [sessionItem("s-9", { summaryLine: `Fixed the ${u.searchParams.get("q")} test` })]
								: [sessionItem("s-1"), sessionItem("s-2"), sessionItem("s-3")],
							total: 3,
							nextCursor: null,
						},
					}
				: undefined,
		(u) => (u.pathname.startsWith("/api/sessions/") ? { body: sessionDetail(u.pathname.split("/")[3]) } : undefined),
		route("/api/repos", {
			repos: [
				{
					id: "github.com/acme/api-gateway",
					name: "api-gateway",
					remoteUrl: null,
					branch: null,
					branchesSeen: 1,
					sessions: 1,
					tokens: 0,
					costUsd: 0,
					linesAdded: 0,
					linesRemoved: 0,
					repoSkillsUsed: 0,
					repoSkillsAvailable: 0,
					repoMcp: [],
				},
			],
		}),
		route("/api/inventory", {
			strip: {
				installed: 1,
				byScope: { user: 1, plugin: 0, repo: 0 },
				invoked: 0,
				neverInvoked: 0,
				unusedCtxTokensPerSession: 0,
			},
			items: [
				{
					id: 1,
					name: "pdf-tools",
					source: "user",
					scope: "user",
					path: "/x",
					sessionsLoaded: 0,
					sessionsInvoked: 0,
					lastUsed: null,
					ctxTokens: 0,
					status: "never_used",
					removed: false,
				},
			],
		}),
		route("/api/tools", {
			tools: [
				{
					name: "WebFetch",
					calls: 1,
					failures: 0,
					denials: 0,
					medianMs: null,
					sessions: 1,
					lastUsed: null,
					category: "web",
				},
			],
		}),
		route("/api/overview", null),
		route("/api/costs", null),
		route("/api/improvements", { items: [], footer: null }),
	]);
});
afterEach(() => vi.unstubAllGlobals());

const openPalette = async () => {
	await userEvent.keyboard("{Control>}k{/Control}");
	return screen.findByRole("dialog", { name: "Command palette" });
};

describe("Command palette", () => {
	it("Ctrl-K opens it; a view match opens with Enter and closes the palette", async () => {
		at("/settings");
		render(<App />);
		await screen.findByRole("heading", { name: "Settings" });
		const dialog = await openPalette();
		const input = within(dialog).getByRole("combobox", { name: "Search everything" });
		expect(document.activeElement).toBe(input);
		await userEvent.type(input, "cost");
		expect(within(dialog).getByRole("option", { name: /Costs/ })).toBeTruthy();
		await userEvent.keyboard("{Enter}");
		await waitFor(() => expect(window.location.pathname).toBe("/costs"));
		expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
	});

	it("finds sessions through the sessions search, and repos, skills and tools by name", async () => {
		at("/settings");
		render(<App />);
		await screen.findByRole("heading", { name: "Settings" });
		const dialog = await openPalette();
		const input = within(dialog).getByRole("combobox", { name: "Search everything" });
		await userEvent.type(input, "flaky");
		const hit = await within(dialog).findByRole("option", { name: /Fixed the flaky test/ });
		expect(log.some((u) => u.pathname === "/api/sessions" && u.searchParams.get("q") === "flaky")).toBe(true);
		await userEvent.clear(input);
		await userEvent.type(input, "api-gate");
		expect(await within(dialog).findByRole("option", { name: /api-gateway/ })).toBeTruthy();
		await userEvent.clear(input);
		await userEvent.type(input, "pdf");
		expect(await within(dialog).findByRole("option", { name: /pdf-tools/ })).toBeTruthy();
		await userEvent.clear(input);
		await userEvent.type(input, "webf");
		expect(await within(dialog).findByRole("option", { name: /WebFetch/ })).toBeTruthy();
		expect(hit).toBeTruthy();
	});

	it("arrow keys move the active option; Esc closes and gives focus back", async () => {
		at("/settings");
		render(<App />);
		await screen.findByRole("heading", { name: "Settings" });
		const before = screen.getByRole("link", { name: "Overview" });
		before.focus();
		const dialog = await openPalette();
		const options = within(dialog).getAllByRole("option");
		expect(options[0].getAttribute("aria-selected")).toBe("true");
		await userEvent.keyboard("{ArrowDown}");
		expect(within(dialog).getAllByRole("option")[1].getAttribute("aria-selected")).toBe("true");
		await userEvent.keyboard("{Tab}");
		expect(dialog.contains(document.activeElement)).toBe(true); // focus stays inside
		await userEvent.keyboard("{Escape}");
		expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
		expect(document.activeElement).toBe(before);
	});
});

describe("Keyboard navigation", () => {
	it("g then a letter opens a view", async () => {
		at("/settings");
		render(<App />);
		await screen.findByRole("heading", { name: "Settings" });
		await userEvent.keyboard("gc");
		await waitFor(() => expect(window.location.pathname).toBe("/costs"));
		await userEvent.keyboard("gt");
		await waitFor(() => expect(window.location.pathname).toBe("/tasks"));
	});

	it("keys are ignored while typing in a field", async () => {
		at("/sessions");
		render(<App />);
		const search = await screen.findByRole("searchbox", { name: "Search prompts and summaries" });
		await userEvent.type(search, "gc");
		expect(window.location.pathname).toBe("/sessions");
	});

	it("/ focuses the view's search; ? shows the key list", async () => {
		at("/sessions");
		render(<App />);
		const search = await screen.findByRole("searchbox", { name: "Search prompts and summaries" });
		await screen.findAllByRole("option");
		await userEvent.keyboard("/");
		expect(document.activeElement).toBe(search);
		search.blur();
		await userEvent.keyboard("?");
		const keys = await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
		expect(within(keys).getByText("Costs")).toBeTruthy();
		await userEvent.keyboard("{Escape}");
		expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).toBeNull();
	});

	it("j and k move through list rows and Enter opens one", async () => {
		at("/sessions");
		render(<App />);
		await screen.findAllByRole("option");
		await userEvent.keyboard("j");
		expect(document.activeElement?.id).toBe("session-s-1");
		await userEvent.keyboard("j");
		expect(document.activeElement?.id).toBe("session-s-2");
		await userEvent.keyboard("k");
		expect(document.activeElement?.id).toBe("session-s-1");
		await userEvent.keyboard("{Enter}");
		await waitFor(() => expect(window.location.pathname).toBe("/sessions/s-1"));
	});
});

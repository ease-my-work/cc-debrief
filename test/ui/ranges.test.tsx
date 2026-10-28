// Phase 7 Task 3 (P1): the 90-day and all ranges in the range controls, round-tripped through the URL.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../ui/src/app";
import { at, mockFetch, route, statusFixture } from "./helpers";

afterEach(() => vi.unstubAllGlobals());

const overview = {
	tiles: {
		sessions: { total: 0, bySurface: { cli: 0, vscode: 0, desktop: 0, unknown: 0 }, byRepo: [] },
		tokens: { total: 0, cacheServedPct: 0 },
		cost: { usd: 0, byModel: [], unknownModelTokens: 0 },
		lines: { added: 0, removed: 0, files: 0, repos: 0 },
	},
	tokensPerDay: [],
	chartNote: null,
	recent: [],
};

function start(path: string): URL[] {
	at(path);
	const log = mockFetch([
		route("/api/status", statusFixture()),
		route("/api/overview", overview),
		route("/api/repos", { repos: [] }),
		route("/api/sessions", { items: [], total: 0, nextCursor: null }),
		route("/api/improvements", { items: [], footer: null }),
	]);
	render(<App />);
	return log;
}

describe("range controls", () => {
	it("Overview offers 90 days and All, and All goes to the API and the URL", async () => {
		const log = start("/");
		await userEvent.click(await screen.findByRole("button", { name: "All" }));
		await waitFor(() =>
			expect(log.some((u) => u.pathname === "/api/overview" && u.searchParams.get("range") === "all")).toBe(true),
		);
		expect(new URLSearchParams(window.location.search).get("range")).toBe("all");
		expect(screen.getByRole("button", { name: "90 days" })).toBeTruthy();
	});

	it("a 90d URL is read back on load", async () => {
		const log = start("/?range=90d");
		await waitFor(() =>
			expect(log.some((u) => u.pathname === "/api/overview" && u.searchParams.get("range") === "90d")).toBe(true),
		);
	});

	it("the Sessions range select lists the two new values", async () => {
		start("/sessions");
		const select = (await screen.findByRole("combobox", { name: "Date range" })) as HTMLSelectElement;
		expect([...select.options].map((o) => o.textContent)).toEqual([
			"Today",
			"Last 7 days",
			"Last 30 days",
			"Last 90 days",
			"All retained",
		]);
	});
});

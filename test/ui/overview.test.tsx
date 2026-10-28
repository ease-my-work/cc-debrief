import type { Overview } from "@api-types";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../ui/src/app";
import { at, mockFetch, route, sessionItem, statusFixture } from "./helpers";

const days7 = ["2026-09-26", "2026-09-27", "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"];
const overview = (over: Partial<Overview> = {}): Overview => ({
	tiles: {
		sessions: { total: 42, bySurface: { cli: 31, vscode: 9, desktop: 2, unknown: 0 }, byRepo: [] },
		tokens: { total: 3_800_000, cacheServedPct: 71 },
		cost: {
			usd: 18.4,
			byModel: [
				{ model: "claude-sonnet-4-5", label: "Sonnet", usd: 9.1 },
				{ model: "claude-opus-4-1", label: "Opus", usd: 9.3 },
			],
			unknownModelTokens: 0,
		},
		lines: { added: 2140, removed: 860, files: 118, repos: 4 },
	},
	tokensPerDay: days7.map((date, i) => ({ date, input: 1000 * i, cacheRead: 2000 * i, output: 100 * i })),
	chartNote: null,
	recent: [sessionItem("s-1", { summaryLine: "Fixed migration ordering" }), sessionItem("s-2")],
	budget: null,
	...over,
});

let log: URL[];
beforeEach(() => {
	at("/");
});
afterEach(() => vi.unstubAllGlobals());

const start = (o: Overview = overview(), status = statusFixture()) => {
	log = mockFetch([
		route("/api/status", status),
		route("/api/overview", o),
		route("/api/repos", { repos: [] }),
		route("/api/sessions", { items: [], total: 0, nextCursor: null }),
		route("/api/improvements", {
			items: [],
			footer: {
				reviewsThisWeek: 0,
				reviewCostUsd: 0,
				dismissed: 0,
				eligibleUnreviewed: 0,
				estReviewAllUsd: 0,
				reviewsEnabled: false,
				nudgeDismissed: true,
				selfUsage: { summaries: 0, reviews: 0, drafts: 0, recaps: 0, tokens: 0, usd: 0, sharePct: null },
			},
		}),
	]);
	render(<App />);
};

describe("Overview", () => {
	it("shows the four tiles with feature 12's labels", async () => {
		start();
		expect(await screen.findByText("42")).toBeTruthy();
		expect(screen.getByText("31 CLI · 9 VS Code · 2 desktop")).toBeTruthy();
		expect(screen.getByText("3.8M")).toBeTruthy();
		expect(screen.getByText("71% served from cache")).toBeTruthy();
		expect(screen.getByText("$18.40")).toBeTruthy();
		expect(screen.getByText("Sonnet $9.10 · Opus $9.30")).toBeTruthy();
		expect(screen.getByText("+2,140")).toBeTruthy();
		expect(screen.getByText("−860")).toBeTruthy();
		expect(screen.getByText("118 files across 4 repos")).toBeTruthy();
		for (const h of ["Sessions", "Tokens", "Est. cost", "Code changed"])
			expect(screen.getAllByText(h).length).toBeGreaterThan(0);
	});

	it("notes unpriced tokens on the cost tile", async () => {
		const o = overview();
		o.tiles.cost.unknownModelTokens = 12_000;
		start(o);
		expect(await screen.findByText(/12k tokens unpriced/)).toBeTruthy();
	});

	it("labels the chart and gives it a hidden data table with one row per day", async () => {
		start();
		const chart = await screen.findByRole("figure", { name: /Tokens per day/ });
		expect(chart).toBeTruthy();
		const table = screen.getByRole("table", { name: "Tokens per day" });
		expect(within(table).getAllByRole("row")).toHaveLength(1 + 7);
		expect(within(table).getByText("2026-10-02")).toBeTruthy();
	});

	it("shows the digest card's empty state", async () => {
		start();
		expect(await screen.findByText("No costly patterns this week")).toBeTruthy();
	});

	it("opens a session from the recent table", async () => {
		start();
		await userEvent.click(await screen.findByText("Fixed migration ordering"));
		await waitFor(() => expect(window.location.pathname).toBe("/sessions/s-1"));
	});

	it("puts the range in the URL and refetches", async () => {
		start();
		await screen.findByText("42");
		await userEvent.click(screen.getByRole("button", { name: "30 days" }));
		await waitFor(() => expect(new URLSearchParams(window.location.search).get("range")).toBe("30d"));
		await waitFor(() =>
			expect(log.some((u) => u.pathname === "/api/overview" && u.searchParams.get("range") === "30d")).toBe(true),
		);
		expect(screen.getByRole("button", { name: "30 days" }).getAttribute("aria-pressed")).toBe("true");
	});

	it("shows the first-run empty state with the doctor command", async () => {
		const empty = overview({
			tiles: {
				sessions: { total: 0, bySurface: { cli: 0, vscode: 0, desktop: 0, unknown: 0 }, byRepo: [] },
				tokens: { total: 0, cacheServedPct: 0 },
				cost: { usd: 0, byModel: [], unknownModelTokens: 0 },
				lines: { added: 0, removed: 0, files: 0, repos: 0 },
			},
			recent: [],
		});
		start(empty, statusFixture({ lastIngestAt: null }));
		expect(await screen.findByText("No sessions captured yet")).toBeTruthy();
		expect(screen.getByText("cc-debrief doctor")).toBeTruthy();
	});
});

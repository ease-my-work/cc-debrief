// Phase 7 Task 5: the Costs view (feature 18; mockup Costs.html).
import type { CostsResponse } from "@api-types";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../ui/src/app";
import { at, mockFetch, route, statusFixture } from "./helpers";

afterEach(() => vi.unstubAllGlobals());

const costsFixture = (over: Partial<CostsResponse> = {}): CostsResponse => ({
	perDay: ["2026-10-15", "2026-10-16", "2026-10-17"].map((date, i) => ({
		date,
		byModel: { Opus: 2 * i, Sonnet: 1 },
	})),
	byRepo: [
		{ repoId: "github.com/acme/api", name: "api", usd: 142.1 },
		{ repoId: null, name: "no repo", usd: 16.3 },
	],
	models: [
		{
			model: "claude-opus-5-5",
			label: "Opus",
			input: 2_100_000,
			cacheWrite: 14_000_000,
			cacheRead: 412_000_000,
			output: 3_800_000,
			usd: 201.3,
		},
		{
			model: "acme-local-7b",
			label: "acme-local-7b",
			input: 200_000,
			cacheWrite: 0,
			cacheRead: 0,
			output: 100_000,
			usd: null,
		},
	],
	totalUsd: 286.4,
	unknownModelTokens: 300_000,
	cacheHitPct: 88.2,
	cacheSavingsUsd: 1140,
	runRate: {
		last30Usd: 281.9,
		monthlyUsd: 286.12,
		plans: [
			{ name: "Pro", usd: 20 },
			{ name: "Max 5x", usd: 100 },
			{ name: "Max 20x", usd: 200 },
		],
		pricesAsOf: "2026-10-17",
	},
	truncated: false,
	beforeUsd: 0,
	budget: null,
	...over,
});

function start(body: CostsResponse | ((u: URL) => CostsResponse), path = "/costs"): URL[] {
	at(path);
	const log = mockFetch([
		route("/api/status", statusFixture()),
		route("/api/costs", body),
		route("/api/repos", { repos: [] }),
		route("/api/config", { config: { budget: { monthlyUsd: null } } }),
	]);
	render(<App />);
	return log;
}

describe("Costs view", () => {
	it("shows the tiles, the run-rate line, the model and repo tables", async () => {
		start(costsFixture());
		await screen.findByRole("heading", { name: "Costs" });
		expect(screen.getByText("$286.40")).toBeTruthy();
		expect(screen.getByText("88.2%")).toBeTruthy();
		expect(screen.getByText("$1,140.00")).toBeTruthy();
		expect(
			screen.getByText(
				"Last 30 days at API prices: ≈ $286.12/month. Pro $20 · Max 5x $100 · Max 20x $200 (prices as of 2026-10-17)",
			),
		).toBeTruthy();
		const models = within(screen.getByRole("table", { name: "Cost by model" }));
		expect(models.getByText("claude-opus-5-5")).toBeTruthy();
		expect(models.getByText("412M")).toBeTruthy();
		expect(models.getByText("not priced")).toBeTruthy();
		const repos = within(screen.getByRole("table", { name: "Cost by repo" }));
		expect(repos.getByRole("link", { name: "api" }).getAttribute("href")).toBe("/repos/github.com%2Facme%2Fapi");
		expect(repos.getByText("no repo")).toBeTruthy();
		expect(screen.getByRole("figure", { name: /Cost per day, 3 days/ })).toBeTruthy();
	});

	it("is in the sidebar", async () => {
		start(costsFixture(), "/");
		await userEvent.click(await screen.findByRole("link", { name: "Costs" }));
		await screen.findByRole("heading", { name: "Costs" });
		expect(window.location.pathname).toBe("/costs");
	});

	it("asks the API for the chosen range and says when days were cut", async () => {
		const log = start((u) =>
			costsFixture(u.searchParams.get("range") === "all" ? { truncated: true, beforeUsd: 12.5 } : {}),
		);
		await screen.findByRole("heading", { name: "Costs" });
		await userEvent.click(screen.getByRole("button", { name: "All" }));
		await waitFor(() =>
			expect(log.some((u) => u.pathname === "/api/costs" && u.searchParams.get("range") === "all")).toBe(true),
		);
		expect(await screen.findByText("showing the newest 366 days; $12.50 before that not shown")).toBeTruthy();
	});

	it("an empty range says no cost yet and has no run-rate line", async () => {
		start(
			costsFixture({
				perDay: [],
				byRepo: [],
				models: [],
				totalUsd: 0,
				unknownModelTokens: 0,
				cacheHitPct: 0,
				cacheSavingsUsd: 0,
				runRate: { ...costsFixture().runRate, last30Usd: 0, monthlyUsd: 0 },
			}),
		);
		expect(await screen.findByText("No cost yet")).toBeTruthy();
		expect(screen.queryByText(/Last 30 days at API prices/)).toBeNull();
	});
});

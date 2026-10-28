// Phase 7 Task 6 (P4): the budget band on Overview and Costs.
import type { BudgetState, CostsResponse, Overview } from "@api-types";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../ui/src/app";
import { at, mockFetch, route, statusFixture } from "./helpers";

afterEach(() => vi.unstubAllGlobals());

const WARN: BudgetState = { budgetUsd: 250, monthToDateUsd: 212, projectedUsd: 388, level: "warn", daysLeft: 14 };

const overview = (budget: BudgetState | null): Overview => ({
	tiles: {
		sessions: { total: 1, bySurface: { cli: 1, vscode: 0, desktop: 0, unknown: 0 }, byRepo: [] },
		tokens: { total: 10, cacheServedPct: 0 },
		cost: { usd: 1, byModel: [], unknownModelTokens: 0 },
		lines: { added: 0, removed: 0, files: 0, repos: 0 },
	},
	tokensPerDay: [],
	chartNote: null,
	recent: [],
	budget,
});

const costs = (budget: BudgetState | null): CostsResponse => ({
	perDay: [],
	byRepo: [],
	models: [],
	totalUsd: 0,
	unknownModelTokens: 0,
	cacheHitPct: 0,
	cacheSavingsUsd: 0,
	runRate: { last30Usd: 0, monthlyUsd: 0, plans: [], pricesAsOf: "2026-10-17" },
	truncated: false,
	beforeUsd: 0,
	budget,
});

function start(path: string, budget: BudgetState | null) {
	at(path);
	mockFetch([
		route("/api/status", statusFixture()),
		route("/api/overview", overview(budget)),
		route("/api/costs", costs(budget)),
		route("/api/repos", { repos: [] }),
		route("/api/improvements", { items: [], footer: null }),
	]);
	render(<App />);
}

describe("budget band", () => {
	it.each(["/", "/costs"])("%s shows month-to-date, the projection and days left", async (path) => {
		start(path, WARN);
		const band = await screen.findByRole("status", { name: "Monthly budget" });
		expect(band.textContent).toBe("$212.00 of $250.00 this month · on pace for $388.00 · 14 days left");
		expect(band.getAttribute("data-level")).toBe("warn");
	});

	it("says over the budget at the over level", async () => {
		start("/", { ...WARN, projectedUsd: 410, level: "over" });
		const band = await screen.findByRole("status", { name: "Monthly budget" });
		expect(band.textContent).toContain("over the $250.00 budget");
		expect(band.getAttribute("data-level")).toBe("over");
	});

	it("is hidden when no budget is set", async () => {
		start("/costs", null);
		await screen.findByRole("heading", { name: "Costs" });
		expect(screen.queryByRole("status", { name: "Monthly budget" })).toBeNull();
	});
});

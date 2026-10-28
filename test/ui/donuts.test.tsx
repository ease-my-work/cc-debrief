// Phase 7 Task 9 (P13): the Overview donuts — cost by model and sessions by repo, with one-slice and empty cases.
import type { Overview } from "@api-types";
import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../ui/src/app";
import { Donut } from "../../ui/src/components/Donut";
import { at, mockFetch, route, statusFixture } from "./helpers";

afterEach(() => vi.unstubAllGlobals());

const overview = (
	cost: Overview["tiles"]["cost"]["byModel"],
	byRepo: Overview["tiles"]["sessions"]["byRepo"],
): Overview => ({
	tiles: {
		sessions: { total: 5, bySurface: { cli: 5, vscode: 0, desktop: 0, unknown: 0 }, byRepo },
		tokens: { total: 10, cacheServedPct: 0 },
		cost: { usd: cost.reduce((n, m) => n + m.usd, 0), byModel: cost, unknownModelTokens: 0 },
		lines: { added: 0, removed: 0, files: 0, repos: 0 },
	},
	tokensPerDay: [],
	chartNote: null,
	recent: [],
	budget: null,
});

function start(o: Overview) {
	at("/");
	mockFetch([
		route("/api/status", statusFixture()),
		route("/api/overview", o),
		route("/api/repos", { repos: [] }),
		route("/api/improvements", { items: [], footer: null }),
	]);
	render(<App />);
}

describe("Overview donuts", () => {
	it("shows cost by model and sessions by repo with legends", async () => {
		start(
			overview(
				[
					{ model: "claude-opus-4-1", label: "Opus", usd: 9.3 },
					{ model: "claude-sonnet-4-5", label: "Sonnet", usd: 9.1 },
				],
				[
					{ repoId: "github.com/me/app", name: "app", sessions: 3 },
					{ repoId: null, name: "other", sessions: 2 },
				],
			),
		);
		const cost = await screen.findByRole("figure", { name: "Cost by model: Opus $9.30, Sonnet $9.10" });
		expect(within(cost).getByText("2 models")).toBeTruthy();
		const repos = screen.getByRole("figure", { name: "Sessions by repo: app 3, other 2" });
		expect(within(repos).getAllByRole("listitem")).toHaveLength(2);
	});
});

describe("Donut", () => {
	it("draws one slice as a full ring", () => {
		const { container } = render(
			<Donut title="Cost by model" center="$5.00" slices={[{ label: "Opus", value: 5, text: "$5.00" }]} />,
		);
		const arcs = container.querySelectorAll("circle[data-slice]");
		expect(arcs).toHaveLength(1);
		expect(arcs[0].getAttribute("stroke-dasharray")).toMatch(/^100 0$/);
	});

	it("an empty donut is an outline with a dash", () => {
		const { container } = render(<Donut title="Sessions by repo" center="0" slices={[]} />);
		expect(container.querySelectorAll("circle[data-slice]")).toHaveLength(0);
		expect(screen.getByRole("figure", { name: "Sessions by repo: none" })).toBeTruthy();
		expect(screen.getByText("—")).toBeTruthy();
	});
});

import type { DigestFooter, SelfUsageLine } from "@api-types";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../ui/src/app";
import { selfUsageText, sharePctText } from "../../ui/src/components/DigestCard";
import { at, mockFetch, requests, route, statusFixture } from "./helpers";

const line = (over: Partial<SelfUsageLine> = {}): SelfUsageLine => ({
	summaries: 42,
	reviews: 6,
	drafts: 0,
	recaps: 0,
	tokens: 310_000,
	usd: 1.4,
	sharePct: 7.07,
	...over,
});

describe("self-usage line (feature 15 format)", () => {
	it("formats calls, tokens, USD and the share", () => {
		expect(selfUsageText(line())).toBe(
			"This package used: 42 summaries + 6 reviews · 310k tokens · $1.40 · 7% of your week",
		);
	});
	it("says nothing was used", () => {
		expect(selfUsageText(line({ summaries: 0, reviews: 0, tokens: 0, usd: 0, sharePct: null }))).toBe(
			"This package used nothing this week",
		);
	});
	it("adds drafts and recaps only when there are some", () => {
		expect(selfUsageText(line({ summaries: 1, reviews: 0, drafts: 2, recaps: 1 }))).toMatch(
			/^This package used: 1 summary \+ 0 reviews \+ 2 drafts \+ 1 recap · /,
		);
	});
	it("shows <1% for a tiny share and — without a denominator", () => {
		expect(sharePctText(0.01)).toBe("<1%");
		expect(sharePctText(0.5)).toBe("1%");
		expect(sharePctText(0)).toBe("0%");
		expect(sharePctText(null)).toBe("—");
	});
});

describe("digest card footer on the Overview", () => {
	let footer: DigestFooter;
	beforeEach(() => {
		footer = {
			reviewsThisWeek: 0,
			reviewCostUsd: 0,
			dismissed: 0,
			eligibleUnreviewed: 0,
			estReviewAllUsd: 0,
			reviewsEnabled: false,
			nudgeDismissed: false,
			selfUsage: line(),
		};
		mockFetch([
			route("/api/status", statusFixture()),
			route("/api/repos", { repos: [] }),
			route("/api/overview", {
				tiles: {
					sessions: { total: 1, bySurface: { cli: 1, vscode: 0, desktop: 0, unknown: 0 }, byRepo: [] },
					tokens: { total: 10, cacheServedPct: 0 },
					cost: { usd: 1, byModel: [], unknownModelTokens: 0 },
					lines: { added: 0, removed: 0, files: 0, repos: 0 },
				},
				tokensPerDay: [],
				chartNote: null,
				recent: [],
			}),
			route("/api/improvements", () => ({ items: [], footer })),
			route(
				"/api/nudges/overview/dismiss",
				() => {
					footer = { ...footer, nudgeDismissed: true };
					return { ok: true };
				},
				"POST",
			),
		]);
	});
	afterEach(() => vi.unstubAllGlobals());

	it("shows the self-usage line with a Settings link and the reviews nudge", async () => {
		at("/");
		render(<App />);
		expect(
			await screen.findByText("This package used: 42 summaries + 6 reviews · 310k tokens · $1.40 · 7% of your week"),
		).toBeTruthy();
		const card = within(screen.getByRole("region", { name: "This week's coaching digest" }));
		expect(card.getByRole("link", { name: "Settings" }).getAttribute("href")).toBe("/settings");
		expect(card.getByText("Enable reviews for better insights")).toBeTruthy();
		expect(card.getByRole("link", { name: "Enable reviews" }).getAttribute("href")).toBe("/settings#reviews");
	});

	it("dismissing the nudge hides it and tells the server", async () => {
		at("/");
		render(<App />);
		await userEvent.click(await screen.findByRole("button", { name: "Dismiss tip" }));
		await waitFor(() => expect(screen.queryByText("Enable reviews for better insights")).toBeNull());
		expect(requests.some((r) => r.method === "POST" && r.url.pathname === "/api/nudges/overview/dismiss")).toBe(true);
	});

	it("shows the reviews line instead of the nudge when reviews are on", async () => {
		footer = { ...footer, reviewsEnabled: true, reviewsThisWeek: 6, reviewCostUsd: 0.84, dismissed: 2 };
		at("/");
		render(<App />);
		expect(await screen.findByText("Reviews this week: 6 · $0.84 · 2 dismissed")).toBeTruthy();
		expect(screen.queryByText("Enable reviews for better insights")).toBeNull();
	});

	it("no nudge once dismissed", async () => {
		footer = { ...footer, nudgeDismissed: true };
		at("/");
		render(<App />);
		await screen.findByText(/This package used/);
		expect(screen.queryByText("Enable reviews for better insights")).toBeNull();
	});
});

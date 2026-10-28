import type { DigestFooter, DigestItem } from "@api-types";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../ui/src/app";
import { at, mockFetch, requests, route, statusFixture } from "./helpers";

const footer: DigestFooter = {
	reviewsThisWeek: 0,
	reviewCostUsd: 0,
	dismissed: 0,
	eligibleUnreviewed: 0,
	estReviewAllUsd: 0,
	reviewsEnabled: false,
	nudgeDismissed: true,
	selfUsage: { summaries: 0, reviews: 0, drafts: 0, recaps: 0, tokens: 0, usd: 0, sharePct: null },
};

const item = (id: number, over: Partial<DigestItem> = {}): DigestItem => ({
	id,
	rule: "retry_loop",
	severity: "medium",
	message: `Retry loop in ${id} sessions in \`app\``,
	costTokens: 610_000,
	sessionCount: 4,
	repoId: "github.com/me/app",
	target: "session",
	href: `/sessions/s-${id}`,
	demoted: false,
	collapsed: false,
	feedback: null,
	action: null,
	...over,
});

let items: DigestItem[];
beforeEach(() => {
	items = [
		item(1),
		item(2, { rule: "context_churn", message: "`a.ts` read 5 times — pin key facts", costTokens: 38_000 }),
		item(3, { rule: "unused_skill", target: "skills", href: "/skills?tab=skills&unused=1", costTokens: 4_800 }),
	];
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
		route("/api/improvements", () => ({ items, footer })),
		(u, req) => {
			const m = /^\/api\/findings\/(\d+)\/(feedback|dismiss)$/.exec(u.pathname);
			if (!m || req.method !== "POST") return undefined;
			if (m[2] === "dismiss") {
				items = items.filter((i) => i.id !== Number(m[1]));
				return { body: { ok: true, dismissedUntil: "2026-11-01T00:00:00.000Z" } };
			}
			return { body: { ok: true, demoted: false } };
		},
	]);
});
afterEach(() => vi.unstubAllGlobals());

const card = async () => {
	at("/");
	render(<App />);
	await screen.findByText(/Retry loop in 1 sessions/);
	return within(screen.getByRole("region", { name: "This week's coaching digest" }));
};
const rows = () =>
	screen.getAllByRole("listitem").filter((li) => li.closest('[aria-label="This week\'s coaching digest"]'));

describe("coaching digest card", () => {
	it("renders up to three ranked items with dot colour, message link and token text", async () => {
		const c = await card();
		expect(c.getByText("ranked by cost")).toBeTruthy();
		const list = rows();
		expect(list).toHaveLength(3);
		const first = within(list[0]);
		expect(first.getByRole("link", { name: /Retry loop in 1 sessions in/ }).getAttribute("href")).toBe("/sessions/s-1");
		expect(first.getByText("≈ 610k tokens")).toBeTruthy();
		expect((list[0].querySelector("[data-dot]") as HTMLElement).style.background).toBe("rgb(201, 119, 46)");
		expect(within(list[2]).getByRole("link").getAttribute("href")).toBe("/skills?tab=skills&unused=1");
		// `code` spans render monospaced
		expect(within(list[1]).getByText("a.ts").className).toContain("mono");
	});

	it("sends helpful / not helpful and shows the voted state", async () => {
		await card();
		const first = within(rows()[0]);
		const up = first.getByRole("button", { name: "Helpful" });
		const down = first.getByRole("button", { name: "Not helpful" });
		expect(up.getAttribute("aria-pressed")).toBe("false");
		await userEvent.click(down);
		await waitFor(() => expect(down.getAttribute("aria-pressed")).toBe("true"));
		expect(up.getAttribute("aria-pressed")).toBe("false");
		expect(requests.find((r) => r.url.pathname === "/api/findings/1/feedback")?.body).toEqual({ value: "not_helpful" });
	});

	it("shows a stored vote", async () => {
		items[0] = item(1, { feedback: "helpful" });
		await card();
		const first = within(rows()[0]);
		expect(first.getByRole("button", { name: "Helpful" }).getAttribute("aria-pressed")).toBe("true");
		expect(first.getByRole("button", { name: "Not helpful" }).getAttribute("aria-pressed")).toBe("false");
	});

	it("shows dismiss on keyboard focus and removes the item", async () => {
		await card();
		const first = rows()[0];
		expect(within(first).queryByRole("button", { name: "Dismiss" })).toBeNull();
		act(() => within(first).getByRole("link").focus());
		await userEvent.click(within(first).getByRole("button", { name: "Dismiss" }));
		await waitFor(() => expect(screen.queryByText(/Retry loop in 1 sessions/)).toBeNull());
		expect(requests.some((r) => r.method === "POST" && r.url.pathname === "/api/findings/1/dismiss")).toBe(true);
		expect(rows()).toHaveLength(2);
	});

	it("shows dismiss on hover", async () => {
		await card();
		const first = rows()[0];
		fireEvent.mouseEnter(first);
		expect(within(first).getByRole("button", { name: "Dismiss" })).toBeTruthy();
	});

	it("says no costly patterns when there are no items", async () => {
		items = [];
		at("/");
		render(<App />);
		expect(await screen.findByText("No costly patterns this week")).toBeTruthy();
	});

	it("passes the overview's range and repo to /api/improvements", async () => {
		at("/?range=30d");
		render(<App />);
		await screen.findByText(/Retry loop in 1 sessions/);
		const calls = requests.filter((r) => r.url.pathname === "/api/improvements");
		expect(calls.at(-1)?.url.searchParams.get("range")).toBe("30d");
	});
});

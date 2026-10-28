import type { DigestFooter, ReviewBand, SessionDetail, StatusResponse } from "@api-types";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../ui/src/app";
import { at, type Handler, mockFetch, requests, route, sessionDetail, sessionItem, statusFixture } from "./helpers";

const finding = (over: Partial<ReviewBand["findings"][number]> = {}): ReviewBand["findings"][number] => ({
	id: 21,
	rule: "goal_drift",
	label: "goal drift",
	severity: "medium",
	message: '2 goals: add retry (turns 1–4), then "rename" at turn 5 — 900 tokens on the later goal',
	turns: [5],
	costTokens: 900,
	collapsed: false,
	feedback: null,
	...over,
});
const TIER2: NonNullable<ReviewBand["tier2"]> = {
	betterApproach: "Point Claude at docs/adr-12.md first.",
	whatWentWell: "Tests ran after every edit.",
	suggestedFirstPrompt: "Add exponential retry to src/billing/client.ts.",
	confidence: "high",
	costUsd: 0.14,
	model: "claude-sonnet-4-5",
	feedback: null,
};
const band = (over: Partial<ReviewBand> = {}): ReviewBand => ({
	state: "not_reviewed",
	estUsd: 0.18,
	capReached: false,
	findings: [finding()],
	tier2: null,
	dismissedUntil: null,
	permissionPrompts: "recorded",
	nudgeDismissed: false,
	...over,
});

afterEach(() => vi.unstubAllGlobals());

describe("Session review band, Tier 2", () => {
	let detail: SessionDetail;
	const mount = (b: ReviewBand, extra: Handler[] = []) => {
		detail = sessionDetail("s-1", { review: b });
		mockFetch([
			...extra,
			route("/api/status", statusFixture()),
			route("/api/repos", { repos: [] }),
			route("/api/sessions", { items: [sessionItem("s-1")], total: 1, nextCursor: null }),
			route("/api/sessions/s-1", () => detail),
		]);
	};
	const open = async () => {
		at("/sessions/s-1");
		render(<App />);
		return within(await screen.findByRole("region", { name: "Session review" }));
	};

	it("unreviewed: the button shows the estimate; after a 200 the header shows the actual cost", async () => {
		mount(band(), [
			(u, req) => {
				if (req.method !== "POST" || u.pathname !== "/api/sessions/s-1/review") return undefined;
				detail = { ...detail, review: band({ state: "reviewed", tier2: TIER2 }) };
				return { body: { reviewId: 1, costUsd: 0.14, band: detail.review } };
			},
		]);
		const b = await open();
		await userEvent.click(b.getByRole("button", { name: "Review this session (~$0.18)" }));
		await waitFor(() => expect(b.getByText(/reviewed · cost/)).toBeTruthy());
		expect(b.getByText("$0.14")).toBeTruthy();
		expect(b.getByText(/confidence high/)).toBeTruthy();
		expect(requests.filter((r) => r.url.pathname === "/api/sessions/s-1/review")).toHaveLength(1);
	});

	it("says cost unknown without an estimate", async () => {
		mount(band({ estUsd: null }));
		const b = await open();
		expect(b.getByRole("button", { name: "Review this session (cost unknown)" })).toBeTruthy();
	});

	it("disables the button with daily cap reached", async () => {
		mount(band({ capReached: true }));
		const b = await open();
		expect((b.getByRole("button", { name: /Review this session/ }) as HTMLButtonElement).disabled).toBe(true);
		expect(b.getByText("daily cap reached")).toBeTruthy();
	});

	it("a 429 says daily cap reached; a 502 shows the reason", async () => {
		let status = 429;
		mount(band(), [
			(u, req) =>
				req.method === "POST" && u.pathname === "/api/sessions/s-1/review"
					? {
							status,
							body: {
								error: {
									code: status === 429 ? "review_cap_reached" : "review_failed",
									message: status === 429 ? "Daily review cap reached" : "exit 1: boom",
								},
							},
						}
					: undefined,
		]);
		const b = await open();
		await userEvent.click(b.getByRole("button", { name: /Review this session/ }));
		await waitFor(() => expect(b.getByRole("status").textContent).toBe("daily cap reached"));
		status = 502;
		await userEvent.click(b.getByRole("button", { name: /Review this session/ }));
		await waitFor(() => expect(b.getByRole("status").textContent).toBe("Review failed: exit 1: boom"));
	});

	it("running: a spinner line and no button", async () => {
		mount(band({ state: "running" }));
		const b = await open();
		expect(b.getByText("Reviewing… up to 3 min")).toBeTruthy();
		expect(b.queryByRole("button", { name: /Review this session/ })).toBeNull();
	});

	it("reviewed: advice, the first prompt with copy, Review again, and low-confidence findings collapsed", async () => {
		const writeText = vi.fn(async () => {});
		vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
		mount(
			band({
				state: "reviewed",
				tier2: TIER2,
				findings: [
					finding(),
					finding({
						id: 22,
						rule: "review_friction",
						label: "friction",
						severity: "low",
						message: "Ambiguous ask at turn 1: vague",
						collapsed: true,
					}),
				],
			}),
		);
		const b = await open();
		expect(b.getByText("Point Claude at docs/adr-12.md first.")).toBeTruthy();
		expect(b.getByText("Tests ran after every edit.")).toBeTruthy();
		expect(b.getByRole("button", { name: "Review again (~$0.18)" })).toBeTruthy();
		await userEvent.click(b.getByRole("button", { name: "Copy" }));
		expect(writeText).toHaveBeenCalledWith("Add exponential retry to src/billing/client.ts.");
		await waitFor(() => expect(b.getByRole("button", { name: "Copied" })).toBeTruthy());
		const group = b.getByText("Low-confidence findings (1)").closest("details") as HTMLDetailsElement;
		expect(group.open).toBe(false);
		await userEvent.click(b.getByText("Low-confidence findings (1)"));
		expect(group.open).toBe(true);
		expect(within(group).getByText("Ambiguous ask at turn 1: vague")).toBeTruthy();
	});

	it("Was this useful? sends one request and shows the vote", async () => {
		mount(band({ state: "reviewed", tier2: TIER2 }), [
			(u, req) =>
				req.method === "POST" && u.pathname === "/api/sessions/s-1/review/feedback"
					? { body: { demoted: [] } }
					: undefined,
		]);
		const b = await open();
		const yes = b.getByRole("button", { name: "Yes" });
		expect(yes.getAttribute("aria-pressed")).toBe("false");
		await userEvent.click(yes);
		await waitFor(() => expect(yes.getAttribute("aria-pressed")).toBe("true"));
		const sent = requests.filter((r) => r.url.pathname === "/api/sessions/s-1/review/feedback");
		expect(sent.map((r) => r.body)).toEqual([{ value: "helpful" }]);
	});
});

describe("session list review badge", () => {
	it('shows "Review (~$)" on eligible rows only', async () => {
		mockFetch([
			route("/api/status", statusFixture()),
			route("/api/repos", { repos: [] }),
			route("/api/sessions", {
				items: [
					sessionItem("e-1", { summaryLine: "eligible one", review: { state: "eligible", estUsd: 0.18 } }),
					sessionItem("r-1", { summaryLine: "reviewed one", review: { state: "reviewed", estUsd: null } }),
					sessionItem("n-1", { summaryLine: "plain one", review: null }),
				],
				total: 3,
				nextCursor: null,
			}),
		]);
		at("/sessions");
		render(<App />);
		const row = (await screen.findByText("eligible one")).closest("a") as HTMLElement;
		expect(within(row).getByText("Review (~$0.18)")).toBeTruthy();
		expect(screen.getAllByText(/^Review \(/)).toHaveLength(1);
	});
});

describe("digest footer reviews", () => {
	const footer = (over: Partial<DigestFooter> = {}): DigestFooter => ({
		reviewsThisWeek: 6,
		reviewCostUsd: 0.84,
		dismissed: 2,
		eligibleUnreviewed: 4,
		estReviewAllUsd: 0.5,
		reviewsEnabled: true,
		nudgeDismissed: false,
		selfUsage: { summaries: 0, reviews: 6, drafts: 0, recaps: 0, tokens: 0, usd: 0.84, sharePct: null },
		...over,
	});
	let status: StatusResponse;
	let f: DigestFooter;
	const mount = (initial: DigestFooter) => {
		f = initial;
		status = statusFixture();
		mockFetch([
			route("/api/status", () => status),
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
			route("/api/improvements", () => ({ items: [], footer: f })),
			(u, req) => {
				if (req.method !== "POST" || u.pathname !== "/api/reviews/run") return undefined;
				status = { ...status, reviewJob: { done: 1, total: 4 } };
				return { body: { queued: 4, estUsd: 0.5 } };
			},
		]);
	};
	const card = async () => {
		at("/");
		render(<App />);
		return within(await screen.findByRole("region", { name: "This week's coaching digest" }));
	};

	it("shows the counters and the eligible line", async () => {
		mount(footer());
		const c = await card();
		await waitFor(() => expect(c.getByText(/Reviews this week: 6/)).toBeTruthy());
		expect(c.getByText(/Reviews this week: 6 · \$0\.84 · 2 dismissed/)).toBeTruthy();
		expect(c.getByText("4 eligible sessions not reviewed")).toBeTruthy();
	});

	it("Review all: confirm with count and estimate, then progress, then reload when the job ends", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		try {
			mount(footer());
			const c = await card();
			await userEvent.click(await c.findByRole("button", { name: "Review all (~$0.50)" }));
			expect(c.getByText("Review 4 sessions (~$0.50)?")).toBeTruthy();
			await userEvent.click(c.getByRole("button", { name: "Review" }));
			await waitFor(() => expect(c.getByRole("status").textContent).toBe("Reviewing 1 of 4…"));
			expect(requests.find((r) => r.url.pathname === "/api/reviews/run")?.body).toEqual({ scope: "eligible_7d" });
			await vi.advanceTimersByTimeAsync(2100);
			await waitFor(() => expect(c.getByRole("status").textContent).toBe("Reviewing 2 of 4…"));
			status = { ...status, reviewJob: null };
			f = footer({ reviewsThisWeek: 10, eligibleUnreviewed: 0 });
			await vi.advanceTimersByTimeAsync(2100);
			await waitFor(() => expect(c.getByText(/Reviews this week: 10/)).toBeTruthy());
			expect(c.queryByText(/eligible sessions? not reviewed/)).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it("cost unknown in the button when the estimate is unknown", async () => {
		mount(footer({ estReviewAllUsd: null }));
		const c = await card();
		expect(await c.findByRole("button", { name: "Review all (cost unknown)" })).toBeTruthy();
	});

	it("reviews off: the nudge instead of the review lines", async () => {
		mount(footer({ reviewsEnabled: false }));
		const c = await card();
		expect(await c.findByText("Enable reviews for better insights")).toBeTruthy();
		expect(c.queryByText(/Reviews this week/)).toBeNull();
		expect(c.queryByRole("button", { name: /Review all/ })).toBeNull();
	});
});

// Phase 7 Task 10 (P8): Session detail replay — full replies as Markdown, per-turn tokens and cost, the cumulative
// curve, filters and find in session. The excerpt timeline stays as the collapsed state.
import type { ReplayResponse, ReplayTurn } from "@api-types";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../ui/src/app";
import { at, mockFetch, route, sessionDetail, sessionItem, statusFixture } from "./helpers";

const turn = (seq: number, over: Partial<ReplayTurn> = {}): ReplayTurn => ({
	seq,
	startedAt: new Date(Date.now() - (10 - seq) * 60_000).toISOString(),
	userText: `ask ${seq}`,
	assistantText: `reply ${seq}`,
	truncated: false,
	tokens: { input: 100, cacheWrite: 0, cacheRead: 1000, output: 50 },
	costUsd: 0.01,
	tools: [],
	failures: 0,
	compaction: false,
	...over,
});

const replay: ReplayResponse = {
	turns: [
		turn(1, { assistantText: "**Fixed** the flaky test", tools: [{ label: "Read", count: 2, failures: 0 }] }),
		turn(2, {
			userText: "run the flaky suite",
			assistantText: `long ${"x".repeat(50)}…[truncated 9000 bytes]`,
			truncated: true,
			tools: [{ label: "Bash npm", count: 3, failures: 2 }],
			failures: 2,
			costUsd: 0.5,
		}),
		turn(3, { compaction: true, costUsd: 0.02 }),
	],
	cumulative: [1150, 2300, 3450],
};

let log: URL[];
beforeEach(() => {
	at("/sessions/s-1");
	log = mockFetch([
		route("/api/status", statusFixture()),
		route("/api/sessions", { items: [sessionItem("s-1")], total: 1, nextCursor: null }),
		route(
			"/api/sessions/s-1",
			sessionDetail("s-1", {
				turns: [
					{ seq: 1, startedAt: new Date().toISOString(), userText: "ask 1", assistantExcerpt: "reply 1", tools: [] },
				],
			}),
		),
		route("/api/sessions/s-1/replay", replay),
		route("/api/repos", { repos: [] }),
	]);
});
afterEach(() => vi.unstubAllGlobals());

const openReplay = async () => {
	render(<App />);
	await userEvent.click(await screen.findByRole("button", { name: "Full replay" }));
	return within(await screen.findByRole("region", { name: "Replay" }));
};

describe("Session replay", () => {
	it("loads only when opened, then shows each reply as Markdown with tokens and cost", async () => {
		render(<App />);
		await screen.findByRole("button", { name: "Full replay" });
		expect(log.some((u) => u.pathname.endsWith("/replay"))).toBe(false);
		await userEvent.click(screen.getByRole("button", { name: "Full replay" }));
		const r = within(await screen.findByRole("region", { name: "Replay" }));
		expect(r.getByText("Fixed").tagName).toBe("STRONG");
		const first = r.getByRole("article", { name: "Turn 1" });
		expect(within(first).getByText("100 in · 0 cache w · 1.0k cache r · 50 out · $0.01")).toBeTruthy();
		expect(within(first).getByText("Read ×2")).toBeTruthy();
		expect(r.getByText("reply cut at 32 KB")).toBeTruthy();
		expect(within(r.getByRole("article", { name: "Turn 3" })).getByText("compacted before this turn")).toBeTruthy();
		expect(r.getByRole("figure", { name: "Cumulative tokens, 3 turns, 3.4k in total" })).toBeTruthy();
	});

	it("filters to turns with failures, compactions, tool calls or the top 10% by cost", async () => {
		const r = await openReplay();
		const shown = () => r.getAllByRole("article").map((a) => a.getAttribute("aria-label"));
		await userEvent.click(r.getByRole("button", { name: "Failures" }));
		expect(shown()).toEqual(["Turn 2"]);
		await userEvent.click(r.getByRole("button", { name: "Failures" }));
		await userEvent.click(r.getByRole("button", { name: "Compactions" }));
		expect(shown()).toEqual(["Turn 3"]);
		await userEvent.click(r.getByRole("button", { name: "Compactions" }));
		await userEvent.click(r.getByRole("button", { name: "Tool calls" }));
		expect(shown()).toEqual(["Turn 1", "Turn 2"]);
		await userEvent.click(r.getByRole("button", { name: "Tool calls" }));
		await userEvent.click(r.getByRole("button", { name: "Top 10% cost" }));
		expect(shown()).toEqual(["Turn 2"]);
	});

	it("finds in prompts and replies with next and previous", async () => {
		const r = await openReplay();
		await userEvent.type(r.getByRole("searchbox", { name: "Find in session" }), "flaky");
		await waitFor(() => expect(r.getByText("1 of 2")).toBeTruthy());
		expect(r.getAllByText(/^flaky$/i, { selector: "mark" })).toHaveLength(2);
		await userEvent.keyboard("{Enter}");
		expect(r.getByText("2 of 2")).toBeTruthy();
		await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
		expect(r.getByText("1 of 2")).toBeTruthy();
		await userEvent.click(r.getByRole("button", { name: "Next match" }));
		expect(r.getByText("2 of 2")).toBeTruthy();
	});

	it("closing the replay returns to the excerpt timeline", async () => {
		const r = await openReplay();
		await userEvent.click(r.getByRole("button", { name: "Close replay" }));
		expect(screen.queryByRole("region", { name: "Replay" })).toBeNull();
		expect(screen.getByRole("button", { name: "Full replay" })).toBeTruthy();
	});
});

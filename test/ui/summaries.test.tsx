import type { SessionDetail, StatusResponse } from "@api-types";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../ui/src/app";
import { at, mockFetch, requests, route, sessionDetail, sessionItem, statusFixture } from "./helpers";

class FakeObserver {
	observe() {}
	unobserve() {}
	disconnect() {}
}

let detail: SessionDetail;
let status: StatusResponse;
let afterSummarize: Partial<SessionDetail>;
beforeEach(() => {
	vi.stubGlobal("IntersectionObserver", FakeObserver);
	detail = sessionDetail("s-1");
	status = statusFixture();
	afterSummarize = {
		summary: "Did the thing.",
		outcome: "completed",
		summaryState: "done",
		type: "feature",
		typeSource: "ai",
	};
	mockFetch([
		route("/api/status", () => status),
		route("/api/repos", { repos: [] }),
		route("/api/sessions", { items: [sessionItem("s-1")], total: 1, nextCursor: null }),
		route("/api/sessions/s-1", () => detail),
		route(
			"/api/sessions/s-1/summarize",
			() => {
				detail = { ...detail, ...afterSummarize };
				return { status: "done", costUsd: 0.02, reason: null };
			},
			"POST",
		),
		route("/api/summaries/estimate", { sessions: 410, estUsd: 8.2, capRemainingToday: 50 }),
		route(
			"/api/summaries/run",
			() => {
				status = { ...status, summaryJob: { done: 3, total: 410 } };
				return { queued: 410 };
			},
			"POST",
		),
	]);
});
afterEach(() => vi.unstubAllGlobals());

const detailPane = async () => screen.findByRole("article", { name: "Session detail" });

describe("summary states in session detail", () => {
	it("shows the summary with its outcome", async () => {
		detail = sessionDetail("s-1", { summary: "Fixed the retry.", outcome: "completed", summaryState: "done" });
		at("/sessions/s-1");
		render(<App />);
		expect(await within(await detailPane()).findByText("Fixed the retry. Outcome: completed.")).toBeTruthy();
		expect(screen.queryByRole("button", { name: /Summarize/ })).toBeNull();
	});

	it("labels a heuristic type", async () => {
		detail = sessionDetail("s-1", { type: "exploration", typeSource: "heuristic" });
		at("/sessions/s-1");
		render(<App />);
		const pane = await detailPane();
		expect(await within(pane).findByText("heuristic")).toBeTruthy();
	});

	it("pending: Summary pending and a Summarize button that fills the summary in", async () => {
		at("/sessions/s-1");
		render(<App />);
		const pane = await detailPane();
		expect(await within(pane).findByText("Summary pending")).toBeTruthy();
		await userEvent.click(within(pane).getByRole("button", { name: "Summarize (~$0.02)" }));
		expect(await within(pane).findByText("Did the thing. Outcome: completed.")).toBeTruthy();
		expect(requests.some((r) => r.method === "POST" && r.url.pathname === "/api/sessions/s-1/summarize")).toBe(true);
	});

	it("an imported pending session also gets the button", async () => {
		detail = sessionDetail("s-1", { imported: true });
		at("/sessions/s-1");
		render(<App />);
		expect(await within(await detailPane()).findByRole("button", { name: "Summarize (~$0.02)" })).toBeTruthy();
	});

	it("failed: shows the reason and offers a retry", async () => {
		detail = sessionDetail("s-1", { summaryState: "error", summaryError: "exit 1: boom" });
		at("/sessions/s-1");
		render(<App />);
		const pane = await detailPane();
		expect(await within(pane).findByText("Summary failed: exit 1: boom")).toBeTruthy();
		expect(within(pane).getByRole("button", { name: "Summarize (~$0.02)" })).toBeTruthy();
	});

	it("off: says so and offers no button", async () => {
		detail = sessionDetail("s-1", { summaryState: "disabled" });
		at("/sessions/s-1");
		render(<App />);
		const pane = await detailPane();
		expect(await within(pane).findByText("Summaries are off")).toBeTruthy();
		expect(within(pane).queryByRole("button", { name: /Summarize/ })).toBeNull();
	});

	it("skipped: explains why", async () => {
		detail = sessionDetail("s-1", { summaryState: "skipped" });
		at("/sessions/s-1");
		render(<App />);
		expect(await within(await detailPane()).findByText("No summary: fewer than 2 turns")).toBeTruthy();
	});

	it("disables the button once today's cap is used up", async () => {
		detail = sessionDetail("s-1", { summaryCapReached: true });
		at("/sessions/s-1");
		render(<App />);
		const button = await within(await detailPane()).findByRole("button", { name: /Summarize/ });
		expect((button as HTMLButtonElement).disabled).toBe(true);
		expect(screen.getByText("daily cap reached")).toBeTruthy();
	});

	it("shows a capped answer from the server", async () => {
		afterSummarize = {};
		mockFetch([
			route("/api/status", () => status),
			route("/api/repos", { repos: [] }),
			route("/api/sessions", { items: [sessionItem("s-1")], total: 1, nextCursor: null }),
			route("/api/sessions/s-1", () => detail),
			route("/api/sessions/s-1/summarize", { status: "capped", costUsd: null, reason: "daily cap reached" }, "POST"),
		]);
		at("/sessions/s-1");
		render(<App />);
		const pane = await detailPane();
		await userEvent.click(await within(pane).findByRole("button", { name: "Summarize (~$0.02)" }));
		expect(await within(pane).findByText("Not summarized: daily cap reached")).toBeTruthy();
	});
});

describe("imported sessions banner", () => {
	it("estimates, asks to confirm, starts the run and shows progress", async () => {
		status = statusFixture({ pendingImportedSummaries: 412 });
		at("/sessions");
		render(<App />);
		const link = await screen.findByRole("button", { name: "Summarize last 30 days (~$8.20)" });
		expect(screen.getByText(/412 imported sessions without summary/)).toBeTruthy();
		await userEvent.click(link);
		expect(await screen.findByText(/Summarize 410 sessions for about \$8\.20\?/)).toBeTruthy();
		await userEvent.click(screen.getByRole("button", { name: "Start" }));
		const run = requests.find((r) => r.method === "POST" && r.url.pathname === "/api/summaries/run");
		expect(run?.body).toEqual({ since: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
		expect(await screen.findByText("Summarizing 3 of 410…")).toBeTruthy();
	});

	it("can be cancelled at the confirm step", async () => {
		status = statusFixture({ pendingImportedSummaries: 5 });
		at("/sessions");
		render(<App />);
		await userEvent.click(await screen.findByRole("button", { name: /Summarize last 30 days/ }));
		await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(requests.some((r) => r.url.pathname === "/api/summaries/run")).toBe(false);
		expect(screen.getByRole("button", { name: /Summarize last 30 days/ })).toBeTruthy();
	});

	it("is hidden with nothing imported pending, or with summaries off", async () => {
		status = statusFixture({ pendingImportedSummaries: 9, ai: { ...statusFixture().ai, summaries: false } });
		at("/sessions");
		render(<App />);
		await screen.findByText("Session s-1");
		await waitFor(() => expect(screen.queryByText(/imported sessions without summary/)).toBeNull());
	});
});

describe("type filter", () => {
	it("sends type=", async () => {
		at("/sessions");
		render(<App />);
		await screen.findByText("Session s-1");
		await userEvent.selectOptions(screen.getByRole("combobox", { name: "Session type" }), "bugfix");
		await waitFor(() =>
			expect(
				requests.some((r) => r.url.pathname === "/api/sessions" && r.url.searchParams.get("type") === "bugfix"),
			).toBe(true),
		);
	});
});

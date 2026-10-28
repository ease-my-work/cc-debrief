// Phase 7 Task 14 (P12): the Tasks & plans view (mockup TasksPlans.html).
import type { TasksPlansResponse } from "@api-types";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../ui/src/app";
import { at, mockFetch, route, statusFixture } from "./helpers";

const body: TasksPlansResponse = {
	tasks: [
		{
			subject: "Add 009 migration",
			status: "in_progress",
			sessionId: "s-1",
			repo: "cc-debrief",
			updatedAt: new Date().toISOString(),
		},
		{
			subject: "Fix tenant migration order",
			status: "completed",
			sessionId: "s-2",
			repo: null,
			updatedAt: new Date(Date.now() - 86_400_000).toISOString(),
		},
	],
	plans: [
		{
			sessionId: "s-3",
			repo: "billing-api",
			ts: new Date().toISOString(),
			plan: "# Cache invalidation\n\n- Publish **license.updated**",
		},
	],
};

let log: URL[];
beforeEach(() => {
	at("/tasks");
	log = mockFetch([
		route("/api/status", statusFixture()),
		route("/api/repos", { repos: [] }),
		route("/api/tasks-plans", (u: URL) => (u.searchParams.get("q") === "nothing" ? { tasks: [], plans: [] } : body)),
	]);
});
afterEach(() => vi.unstubAllGlobals());

describe("Tasks & plans view", () => {
	it("lists tasks with status, repo and a link to their session", async () => {
		render(<App />);
		const table = within(await screen.findByRole("table", { name: "Tasks" }));
		const row = table.getByRole("row", { name: /Add 009 migration/ });
		expect(within(row).getByText("in progress")).toBeTruthy();
		expect(within(row).getByText("cc-debrief")).toBeTruthy();
		expect(within(row).getByRole("link", { name: "open session" }).getAttribute("href")).toBe("/sessions/s-1");
	});

	it("renders plans as Markdown with their session link", async () => {
		render(<App />);
		const plan = await screen.findByRole("article", { name: "Plan in billing-api" });
		expect(within(plan).getByRole("heading", { name: "Cache invalidation" })).toBeTruthy();
		expect(within(plan).getByText("license.updated").tagName).toBe("STRONG");
		expect(within(plan).getByRole("link", { name: "open session" }).getAttribute("href")).toBe("/sessions/s-3");
	});

	it("sends the status filter and the search to the API", async () => {
		render(<App />);
		await screen.findByRole("table", { name: "Tasks" });
		await userEvent.click(screen.getByRole("button", { name: "Completed" }));
		await waitFor(() => expect(log.some((u) => u.searchParams.get("status") === "completed")).toBe(true));
		await userEvent.type(screen.getByRole("searchbox", { name: "Search tasks and plans" }), "nothing");
		await waitFor(() => expect(log.some((u) => u.searchParams.get("q") === "nothing")).toBe(true));
		expect(await screen.findByText(/No tasks or plans in this range/)).toBeTruthy();
	});

	it("is in the sidebar", async () => {
		at("/settings");
		render(<App />);
		await userEvent.click(await screen.findByRole("link", { name: "Tasks & plans" }));
		expect(window.location.pathname).toBe("/tasks");
	});
});

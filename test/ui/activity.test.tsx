// Phase 7 Task 8: the Activity view (feature 18; mockup Activity.html).
import type { ActivityResponse } from "@api-types";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../ui/src/app";
import { at, mockFetch, route, statusFixture } from "./helpers";

afterEach(() => vi.unstubAllGlobals());

const day = (i: number) => {
	const d = new Date(2026, 9, 17 - (364 - i));
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const activity = (over: Partial<ActivityResponse> = {}): ActivityResponse => ({
	days: Array.from({ length: 365 }, (_, i) => ({
		date: day(i),
		sessions: i === 364 ? 7 : i > 300 ? 1 : 0,
		tokens: i === 364 ? 1_200_000 : i > 300 ? 1000 : 0,
		retained: i > 274,
	})),
	streak: { current: 12, longest: 19 },
	activeDays: 24,
	byHour: Array.from({ length: 24 }, (_, h) => (h === 9 ? 17 : h === 15 ? 18 : 1)),
	byWeekday: [6, 24, 27, 25, 22, 19, 8],
	compactedShare: 0.18,
	sessions: 131,
	truncated: false,
	...over,
});

function start(body: ActivityResponse | ((u: URL) => ActivityResponse), path = "/activity"): URL[] {
	at(path);
	const log = mockFetch([
		route("/api/status", statusFixture()),
		route("/api/activity", body),
		route("/api/overview", null),
		route("/api/repos", { repos: [] }),
	]);
	render(<App />);
	return log;
}

describe("Activity view", () => {
	it("shows streaks, active days of the range and the compacted share", async () => {
		start(activity());
		await screen.findByRole("heading", { name: "Activity" });
		expect(screen.getByText("12 days")).toBeTruthy();
		expect(screen.getByText("19 days")).toBeTruthy();
		expect(screen.getByText("24 / 30")).toBeTruthy();
		expect(screen.getByText("18%")).toBeTruthy();
		expect(screen.getByText("131 sessions in the range")).toBeTruthy();
	});

	it("draws 365 heatmap cells with day tooltips and not-retained cells", async () => {
		start(activity());
		const heat = await screen.findByRole("img", { name: "Sessions per day over the last 365 days" });
		const cells = heat.querySelectorAll("[data-date]");
		expect(cells).toHaveLength(365);
		const today = heat.querySelector(`[data-date="${day(364)}"]`);
		expect(today?.getAttribute("title")).toMatch(/· 7 sessions · 1\.2M tokens$/);
		expect(heat.querySelector(`[data-date="${day(0)}"]`)?.getAttribute("title")).toMatch(/· not retained$/);
		expect(heat.querySelector(`[data-date="${day(0)}"]`)?.getAttribute("data-retained")).toBe("false");
	});

	it("lists sessions by hour and by weekday for screen readers", async () => {
		start(activity());
		const hours = within(await screen.findByRole("table", { name: "Sessions by hour of day" }));
		expect(hours.getAllByRole("row")).toHaveLength(25);
		const week = within(screen.getByRole("table", { name: "Sessions by weekday" }));
		expect(week.getByRole("row", { name: "Tue 27" })).toBeTruthy();
	});

	it("is in the sidebar and follows the range", async () => {
		const log = start(activity(), "/settings");
		await userEvent.click(await screen.findByRole("link", { name: "Activity" }));
		await screen.findByRole("heading", { name: "Activity" });
		await userEvent.click(screen.getByRole("button", { name: "90 days" }));
		await waitFor(() =>
			expect(log.some((u) => u.pathname === "/api/activity" && u.searchParams.get("range") === "90d")).toBe(true),
		);
	});

	it("says when the heatmap cannot show all retained data, and has an empty state", async () => {
		start(activity({ truncated: true }));
		expect(
			await screen.findByText("The heatmap shows the last 365 days; the tiles cover all retained data."),
		).toBeTruthy();
	});

	it("an empty database says no sessions yet", async () => {
		start(
			activity({
				days: activity().days.map((d) => ({ ...d, sessions: 0, tokens: 0, retained: false })),
				streak: { current: 0, longest: 0 },
				activeDays: 0,
				sessions: 0,
				byHour: Array(24).fill(0),
				byWeekday: Array(7).fill(0),
				compactedShare: 0,
			}),
		);
		expect(await screen.findByText("No sessions yet")).toBeTruthy();
	});
});

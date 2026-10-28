// The recap card: the Recap view lists each repo with a ×N session
// count, each item with a dot (described vs files / reads) and its start time, and an END OF DAY footer with an
// activity strip. Copy text copies the server's plain text (no times).
import type { PolishedRecap, Recap, RecapGroup, RecapResponse } from "@api-types";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatMarkdown, formatRepo, formatText } from "../../src/recap/format";
import { App } from "../../ui/src/app";
import { at, type Handler, mockFetch, requests, route, statusFixture } from "./helpers";

const pad = (n: number) => String(n).padStart(2, "0");
const local = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const TODAY = local(new Date());
const YESTERDAY = local(new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate() - 1));
/** Local HH:MM of a time on TODAY. */
const todayAt = (h: number, m: number) =>
	new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate(), h, m).toISOString();

const GROUPS: RecapGroup[] = [
	{
		repo: "api-gateway",
		repoId: "github.com/acme/api-gateway",
		turns: 5,
		bullets: [
			{
				text: "Add rate limiting to the public endpoints",
				source: "title",
				files: ["errors.go", "handlers.go"],
				moreFiles: 1,
				sessionIds: ["s-1"],
				firstTurnAt: todayAt(9, 14),
			},
			{
				text: "Fixed the flaky auth test.",
				source: "summary",
				files: [],
				moreFiles: 0,
				sessionIds: ["s-2", "s-3"],
				firstTurnAt: todayAt(11, 26),
			},
		],
	},
	{
		repo: "checkout-flow",
		repoId: "github.com/acme/checkout-flow",
		turns: 2,
		bullets: [
			{
				text: "cart.tsx, api.ts",
				source: "files",
				files: [],
				moreFiles: 0,
				sessionIds: ["s-4"],
				firstTurnAt: todayAt(14, 5),
			},
		],
	},
];
const slots = (active: Record<number, number>) => Array.from({ length: 96 }, (_, i) => active[i] ?? 0);

const recapOf = (over: Partial<Recap> = {}): Recap => ({
	range: { from: TODAY, to: TODAY },
	groupBy: "repo",
	groups: GROUPS,
	days: [],
	hiddenRepos: 0,
	sessions: 4,
	retentionCutoff: null,
	retentionDays: 0,
	activity: [{ date: TODAY, slots: slots({ 36: 2, 37: 1 }) }],
	...over,
});
const responseOf = (r: Recap, est: number | null = 0.01): RecapResponse => ({
	recap: r,
	text: formatText(r),
	markdown: formatMarkdown(r),
	repoText: Object.fromEntries(
		(r.groupBy === "day" ? r.days.flatMap((d) => d.groups) : r.groups).map((g) => [
			g.repo,
			{ text: formatRepo(r, g.repo, "text"), markdown: formatRepo(r, g.repo, "markdown") },
		]),
	),
	polishEstUsd: est,
});
const POLISHED: PolishedRecap = {
	range: { from: TODAY, to: TODAY },
	groups: [{ repo: "api-gateway", items: ["Added rate limiting and fixed the auth test"] }],
	costUsd: 0.012,
};

let current: (u: URL) => RecapResponse;
function mount(extra: Handler[] = [], path = "/recap") {
	mockFetch([...extra, route("/api/status", statusFixture()), route("/api/recap", (u: URL) => current(u))]);
	at(path);
	render(<App />);
}
const card = async () => screen.findByRole("region", { name: "Recap" });
const item = (text: string) => screen.getByText(text).closest("li") as HTMLLIElement;
const lastRecapUrl = () => [...requests].reverse().find((r) => r.url.pathname === "/api/recap")?.url as URL;

let writeText: ReturnType<typeof vi.fn>;
beforeEach(() => {
	current = (u) => {
		const date = u.searchParams.get("date");
		const from = u.searchParams.get("from");
		const range = date ? { from: date, to: date } : from ? { from, to: u.searchParams.get("to") ?? TODAY } : undefined;
		return responseOf(recapOf(range ? { range } : {}));
	};
	writeText = vi.fn(async () => undefined);
	Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});
afterEach(() => vi.unstubAllGlobals());

describe("Recap view", () => {
	it("is in the sidebar after Repos, before Tasks & plans (Phase 7) and Settings, and defaults to today", async () => {
		mount();
		const nav = screen.getByRole("navigation", { name: "Main" });
		const labels = within(nav)
			.getAllByRole("link")
			.map((a) => a.textContent);
		expect(labels.slice(labels.indexOf("Repos"), labels.indexOf("Repos") + 4)).toEqual([
			"Repos",
			"Recap",
			"Tasks & plans",
			"Settings",
		]);
		await card();
		expect(screen.getByRole("link", { name: "Add rate limiting to the public endpoints" })).toBeTruthy();
		const u = lastRecapUrl();
		expect(u.searchParams.get("date")).toBeNull();
		expect(u.searchParams.get("from")).toBeNull();
		expect(screen.getByRole("button", { name: "Today" }).getAttribute("aria-pressed")).toBe("true");
	});

	it("each item shows its start time and a dot by kind; a title's files sit under it", async () => {
		mount();
		await card();
		const titled = item("Add rate limiting to the public endpoints");
		expect(within(titled).getByText("09:14")).toBeTruthy();
		expect(titled.getAttribute("data-kind")).toBe("described");
		expect(within(titled).getByText("errors.go, handlers.go +1")).toBeTruthy();
		expect(within(item("Fixed the flaky auth test.")).getByText("11:26")).toBeTruthy();
		const files = item("cart.tsx, api.ts");
		expect(files.getAttribute("data-kind")).toBe("work");
		expect(within(files).getByText("14:05")).toBeTruthy();
	});

	it("repo headings carry a ×N session count when there is more than one session", async () => {
		mount();
		const c = await card();
		const api = within(c).getByRole("heading", { name: /api-gateway/ });
		expect(api.textContent).toContain("×3");
		expect(within(c).getByRole("heading", { name: /checkout-flow/ }).textContent).not.toContain("×");
	});

	it("a multi-day range by repo prefixes each time with the weekday", async () => {
		const from = local(new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate() - 6));
		current = () => responseOf(recapOf({ range: { from, to: TODAY } }));
		mount([], "/recap?range=week");
		await card();
		const day = new Date(todayAt(9, 14)).toLocaleDateString("en-US", { weekday: "short" });
		expect(within(item("Add rate limiting to the public endpoints")).getByText(`${day} 09:14`)).toBeTruthy();
	});

	it("by day: a heading per day with its repos", async () => {
		current = () =>
			responseOf(
				recapOf({
					groupBy: "day",
					groups: [],
					days: [
						{ date: YESTERDAY, groups: [GROUPS[1]] },
						{ date: TODAY, groups: [GROUPS[0]] },
					],
					range: { from: YESTERDAY, to: TODAY },
				}),
			);
		mount([], "/recap?range=week&groupBy=day");
		const c = await card();
		const days = within(c)
			.getAllByRole("heading", { level: 3 })
			.map((h) => h.textContent);
		expect(days).toHaveLength(2);
		expect(within(c).getByRole("heading", { name: /checkout-flow/ })).toBeTruthy();
	});

	it("END OF DAY footer: item count and an activity strip of the day", async () => {
		mount();
		const c = await card();
		expect(within(c).getByText("END OF DAY")).toBeTruthy();
		expect(within(c).getByText("3 items")).toBeTruthy();
		const strip = within(c).getByRole("img", { name: /Activity/ });
		expect(strip.getAttribute("aria-label")).toBe("Activity: 30m active, 09:00–09:30");
		expect(strip.querySelectorAll("[data-slot]")).toHaveLength(96);
		expect(strip.querySelectorAll('[data-slot="work"]')).toHaveLength(2);
		if (new Date().getHours() < 23) expect(strip.querySelectorAll('[data-slot="later"]').length).toBeGreaterThan(0);
	});

	it("a multi-day footer says how many days and sums the strip by time of day", async () => {
		const from = local(new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate() - 6));
		current = () =>
			responseOf(
				recapOf({
					range: { from, to: TODAY },
					activity: [
						{ date: from, slots: slots({ 36: 1 }) },
						{ date: TODAY, slots: slots({ 36: 1, 40: 1 }) },
					],
				}),
			);
		mount([], "/recap?range=week");
		const c = await card();
		expect(within(c).getByText("7 DAYS")).toBeTruthy();
		const strip = within(c).getByRole("img", { name: /Activity/ });
		expect(strip.querySelectorAll('[data-slot="work"]')).toHaveLength(2);
		expect(strip.querySelectorAll('[data-slot="later"]')).toHaveLength(0);
	});

	it("‹ steps to yesterday with date=; › is disabled on today", async () => {
		mount();
		await card();
		expect((screen.getByRole("button", { name: "Next day" }) as HTMLButtonElement).disabled).toBe(true);
		await userEvent.click(screen.getByRole("button", { name: "Previous day" }));
		await waitFor(() => expect(new URLSearchParams(window.location.search).get("date")).toBe(YESTERDAY));
		await waitFor(() => expect(lastRecapUrl().searchParams.get("date")).toBe(YESTERDAY));
		expect((screen.getByRole("button", { name: "Next day" }) as HTMLButtonElement).disabled).toBe(false);
	});

	it("week has no day stepping", async () => {
		mount([], "/recap?range=week");
		await card();
		expect(lastRecapUrl().searchParams.get("range")).toBe("week");
		expect(screen.queryByRole("button", { name: "Previous day" })).toBeNull();
	});

	it("Custom shows two date inputs and sends from / to", async () => {
		mount();
		await card();
		await userEvent.click(screen.getByRole("button", { name: "Custom" }));
		const from = screen.getByLabelText("From") as HTMLInputElement;
		const to = screen.getByLabelText("To") as HTMLInputElement;
		// A date picker sets the whole value at once (jsdom rejects a date typed key by key).
		fireEvent.change(from, { target: { value: "2026-09-01" } });
		fireEvent.change(to, { target: { value: "2026-09-07" } });
		await waitFor(() => {
			const u = lastRecapUrl();
			expect([u.searchParams.get("from"), u.searchParams.get("to")]).toEqual(["2026-09-01", "2026-09-07"]);
		});
		expect(new URLSearchParams(window.location.search).get("range")).toBe("custom");
	});

	it("By day and Files update the URL and refetch", async () => {
		mount();
		await card();
		await userEvent.click(screen.getByRole("button", { name: "By day" }));
		await waitFor(() => expect(lastRecapUrl().searchParams.get("groupBy")).toBe("day"));
		expect(new URLSearchParams(window.location.search).get("groupBy")).toBe("day");
		await userEvent.click(screen.getByRole("checkbox", { name: "Files" }));
		await waitFor(() => expect(lastRecapUrl().searchParams.get("files")).toBe("0"));
		expect(new URLSearchParams(window.location.search).get("files")).toBe("0");
	});

	it("the URL state survives a reload", async () => {
		mount([], "/recap?range=custom&from=2026-09-01&to=2026-09-07&groupBy=day&files=0");
		await card();
		const u = lastRecapUrl();
		expect(Object.fromEntries(u.searchParams)).toEqual({
			from: "2026-09-01",
			to: "2026-09-07",
			groupBy: "day",
			files: "0",
		});
		expect((screen.getByLabelText("From") as HTMLInputElement).value).toBe("2026-09-01");
	});

	it("Copy text writes the server's plain text (no times); Copy Markdown the markdown", async () => {
		mount();
		await card();
		await userEvent.click(screen.getByRole("button", { name: "Copy text" }));
		expect(writeText).toHaveBeenLastCalledWith(formatText(recapOf()));
		expect(String(writeText.mock.calls.at(-1)?.[0])).not.toContain("09:14");
		expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
		await userEvent.click(screen.getByRole("button", { name: "Copy Markdown" }));
		expect(writeText).toHaveBeenLastCalledWith(formatMarkdown(recapOf()));
	});

	it("per-repo copy writes that repo's text from repoText", async () => {
		mount();
		await card();
		await userEvent.click(screen.getByRole("button", { name: "Copy checkout-flow" }));
		expect(writeText).toHaveBeenLastCalledWith(formatRepo(recapOf(), "checkout-flow", "text"));
	});

	it("a bullet links to its session and says where its text came from", async () => {
		mount();
		await card();
		const link = screen.getByRole("link", { name: "Add rate limiting to the public endpoints" });
		expect(link.getAttribute("href")).toBe("/sessions/s-1");
		await userEvent.hover(link);
		expect(await screen.findByText("from session title")).toBeTruthy();
		await userEvent.hover(screen.getByRole("link", { name: "Fixed the flaky auth test." }));
		const tip = await screen.findByRole("status", { name: "Bullet source" });
		expect(within(tip).getByText(/from AI summary · 2 sessions/)).toBeTruthy();
		expect(
			within(tip)
				.getAllByRole("link")
				.map((a) => a.getAttribute("href")),
		).toEqual(["/sessions/s-2", "/sessions/s-3"]);
	});

	it("footer counts sessions and repos and links hidden repos to Settings", async () => {
		current = () => responseOf(recapOf({ hiddenRepos: 2 }));
		mount();
		const c = await card();
		expect(within(c).getByText(/4 sessions · 2 repos/)).toBeTruthy();
		expect(within(c).getByRole("link", { name: "2 repos hidden · Settings" }).getAttribute("href")).toBe(
			"/settings#recap",
		);
	});

	it("empty state: the empty line and a link to Sessions, no copy or polish", async () => {
		const empty = recapOf({ groups: [], sessions: 0, activity: [] });
		current = () => responseOf(empty, null);
		mount();
		const c = await card();
		expect(within(c).getByText(formatText(empty))).toBeTruthy();
		expect(within(c).getByRole("link", { name: "See all sessions" }).getAttribute("href")).toBe("/sessions");
		expect(within(c).queryByRole("button", { name: /Polish/ })).toBeNull();
		expect(within(c).queryByRole("button", { name: "Copy text" })).toBeNull();
	});

	it("Polish shows the estimate, then the polished items with its cost, and Show original goes back", async () => {
		mount([
			(u, req) =>
				u.pathname === "/api/recap/polish" && req.method === "POST"
					? { body: { polished: POLISHED, text: formatText(POLISHED), markdown: formatMarkdown(POLISHED) } }
					: undefined,
		]);
		await card();
		await userEvent.click(screen.getByRole("button", { name: "Polish with AI (~$0.01)" }));
		expect(await screen.findByText("Added rate limiting and fixed the auth test")).toBeTruthy();
		expect(screen.queryByRole("link", { name: "Add rate limiting to the public endpoints" })).toBeNull();
		expect(screen.getByText("Polished with AI · $0.012")).toBeTruthy();
		expect(requests.find((r) => r.url.pathname === "/api/recap/polish")?.body).toEqual({
			range: "today",
			groupBy: "repo",
		});
		await userEvent.click(screen.getByRole("button", { name: "Copy text" }));
		expect(writeText).toHaveBeenLastCalledWith(formatText(POLISHED));
		await userEvent.click(screen.getByRole("button", { name: "Show original" }));
		expect(screen.getByRole("link", { name: "Add rate limiting to the public endpoints" })).toBeTruthy();
		await userEvent.click(screen.getByRole("button", { name: "Show polished" }));
		expect(screen.getByText("Added rate limiting and fixed the auth test")).toBeTruthy();
	});

	it("a failed polish shows the reason and keeps the original", async () => {
		mount([
			(u, req) =>
				u.pathname === "/api/recap/polish" && req.method === "POST"
					? {
							status: 502,
							body: { error: { code: "polish_failed", message: "polish failed: schema", reason: "schema" } },
						}
					: undefined,
		]);
		await card();
		await userEvent.click(screen.getByRole("button", { name: "Polish with AI (~$0.01)" }));
		expect(await screen.findByText("Polish failed: schema")).toBeTruthy();
		expect(screen.getByRole("link", { name: "Add rate limiting to the public endpoints" })).toBeTruthy();
	});

	it("an unknown estimate reads cost unknown", async () => {
		current = () => responseOf(recapOf(), null);
		mount();
		await card();
		expect(screen.getByRole("button", { name: "Polish with AI (cost unknown)" })).toBeTruthy();
	});
});

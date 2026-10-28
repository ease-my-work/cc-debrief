import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StatusResponse } from "../../src/server/types";
import { App } from "../../ui/src/app";
import { ErrorCard } from "../../ui/src/components/ErrorCard";
import { useApi } from "../../ui/src/lib/useApi";
import { LiveStatusProvider, useLiveRefresh } from "../../ui/src/lib/useLiveRefresh";

const status = (over: Partial<StatusResponse> = {}): StatusResponse => ({
	ai: { summaries: true, reviews: false, autoReview: false, drafts: false },
	lastIngestAt: new Date(Date.now() - 2 * 60_000).toISOString(),
	lastHookEventAt: null,
	hooksInstalled: true,
	backfill: null,
	summaryJob: null,
	reviewJob: null,
	tier1Job: null,
	inProgressSessions: 0,
	pollSeconds: 15,
	pendingSummaries: 0,
	pendingImportedSummaries: 0,
	version: "0.0.0",
	...over,
});

type Route = (url: URL) => { status?: number; body: unknown } | undefined;
let routes: Route[];
const json = (body: unknown, code = 200) =>
	new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json" } });

beforeEach(() => {
	routes = [];
	window.history.replaceState(null, "", "/");
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const url = new URL(String(input), "http://127.0.0.1:4242");
			for (const r of routes) {
				const hit = r(url);
				if (hit) return json(hit.body, hit.status ?? 200);
			}
			return json({ error: { code: "not_found", message: "no mock" } }, 404);
		}),
	);
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

const onStatus = (s: StatusResponse | (() => StatusResponse)) =>
	routes.push((u) => (u.pathname === "/api/status" ? { body: typeof s === "function" ? s() : s } : undefined));

describe("app shell", () => {
	it("renders the sidebar navigation and the status lines", async () => {
		onStatus(status());
		render(<App />);
		for (const label of ["Overview", "Sessions", "Skills & Tools", "Repos"])
			expect(screen.getByRole("link", { name: label })).toBeTruthy();
		expect(await screen.findByText("AI: summaries on · reviews off")).toBeTruthy();
		expect(screen.getByText("Local only · last ingest 2 min ago")).toBeTruthy();
		expect(screen.queryByText(/Hooks off/)).toBeNull();
	});

	it("says when hooks are not installed", async () => {
		onStatus(status({ hooksInstalled: false }));
		render(<App />);
		expect(await screen.findByText(/Hooks off · run/)).toBeTruthy();
		expect(screen.getByText("cc-debrief init")).toBeTruthy();
	});

	it("shows a progress bar while a backfill runs", async () => {
		onStatus(status({ backfill: { done: 120, total: 283 } }));
		render(<App />);
		expect(await screen.findByText("Importing history · 120/283")).toBeTruthy();
		expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("120");
	});

	it("marks the current view's nav link", async () => {
		onStatus(status());
		window.history.replaceState(null, "", "/skills");
		render(<App />);
		expect(screen.getByRole("link", { name: "Skills & Tools" }).getAttribute("aria-current")).toBe("page");
		expect(screen.getByRole("link", { name: "Overview" }).getAttribute("aria-current")).toBeNull();
	});
});

describe("live refresh", () => {
	it("calls onChange once when lastIngestAt changes", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		let current = status({ pollSeconds: 5, lastIngestAt: "2026-10-02T10:00:00.000Z" });
		onStatus(() => current);
		const onChange = vi.fn();
		function Probe() {
			useLiveRefresh(onChange);
			return null;
		}
		render(
			<LiveStatusProvider>
				<Probe />
			</LiveStatusProvider>,
		);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(5_100);
		});
		expect(onChange).not.toHaveBeenCalled();
		current = status({ pollSeconds: 5, lastIngestAt: "2026-10-02T10:00:15.000Z" });
		await act(async () => {
			await vi.advanceTimersByTimeAsync(5_100);
		});
		await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(5_100);
		});
		expect(onChange).toHaveBeenCalledTimes(1);
	});
});

describe("error card", () => {
	it("shows an API failure with retry, and retry refetches", async () => {
		let calls = 0;
		routes.push((u) => {
			if (u.pathname !== "/api/overview") return undefined;
			calls++;
			return calls === 1
				? { status: 500, body: { error: { code: "internal_error", message: "database is locked" } } }
				: { body: { ok: true } };
		});
		function View() {
			const { data, error, reload } = useApi<{ ok: boolean }>("/api/overview", { range: "7d" });
			if (error) return <ErrorCard error={error} onRetry={reload} />;
			return <p>{data ? "loaded" : "loading"}</p>;
		}
		render(<View />);
		expect(await screen.findByText("database is locked")).toBeTruthy();
		await userEvent.click(screen.getByRole("button", { name: "Retry" }));
		expect(await screen.findByText("loaded")).toBeTruthy();
		expect(calls).toBe(2);
	});
});

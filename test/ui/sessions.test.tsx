import type { SessionDetail, SessionsResponse } from "@api-types";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../ui/src/app";
import { ToolChip } from "../../ui/src/components/ToolChip";
import { at, mockFetch, route, sessionItem, statusFixture } from "./helpers";

// jsdom has no IntersectionObserver: a stub the test can fire.
let observed: ((entries: { isIntersecting: boolean }[]) => void)[] = [];
class FakeObserver {
	constructor(cb: (entries: { isIntersecting: boolean }[]) => void) {
		observed.push(cb);
	}
	observe() {}
	unobserve() {}
	disconnect() {}
}

/**
 * Brings the sentinel into view. The observer that knows the next cursor is rebuilt in an effect after page 1
 * renders, and under load that effect can run after findByText resolves, so wait for it before firing.
 */
async function scrollToEnd() {
	await waitFor(() => expect(observed.length).toBeGreaterThan(1));
	act(() => {
		for (const cb of observed) cb([{ isIntersecting: true }]);
	});
}

const page = (ids: string[], nextCursor: string | null, total = 3): SessionsResponse => ({
	items: ids.map((id) => sessionItem(id)),
	total,
	nextCursor,
});

const detail = (id: string, over: Partial<SessionDetail> = {}): SessionDetail => ({
	...sessionItem(id, {
		surface: "vscode",
		startedAt: new Date(2026, 8, 26, 11, 40).toISOString(),
		endedAt: new Date(2026, 8, 26, 12, 52).toISOString(),
	}),
	cwd: "/w/app",
	startReason: "startup",
	permissionMode: "default",
	summary: null,
	outcome: null,
	tags: [],
	summaryState: "pending",
	summaryError: null,
	summaryEstUsd: 0.02,
	summaryCapReached: false,
	resumeCommand: `claude --resume ${id}`,
	tokens: {
		input: 38_000,
		cacheWrite: 62_000,
		cacheRead: 274_000,
		output: 14_000,
		costUsd: 2.1,
		byModel: [],
		unknown: false,
	},
	turns: [1, 2, 3, 4, 5, 6].map((seq) => ({
		seq,
		startedAt: new Date(2026, 8, 26, 11, 40 + seq).toISOString(),
		userText: `Prompt number ${seq}`,
		assistantExcerpt: seq === 1 ? "Found three consumers" : null,
		tools:
			seq === 1
				? [
						{ label: "Grep", count: 4, totalMs: 2100, failures: 0, denials: 0 },
						{ label: "mcp__github__search_code", count: 1, totalMs: 1800, failures: 0, denials: 0 },
					]
				: seq === 2
					? [{ label: "Bash pytest", count: 3, totalMs: 41_000, failures: 3, denials: 0 }]
					: [],
	})),
	toolCallCount: 31,
	files: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts", "g.ts"].map((p, i) => ({
		path: `src/${p}`,
		repo: "app",
		added: 10 - i,
		removed: 1,
		language: "typescript",
	})),
	used: {
		skills: [{ name: "code-review", calls: 1, failures: 0 }],
		mcpServers: [{ name: "github", calls: 3, failures: 1 }],
		tools: [
			{ name: "Read", calls: 12, failures: 0 },
			{ name: "Bash", calls: 5, failures: 2 },
		],
		instructionFiles: [{ path: "/w/app/CLAUDE.md", kind: "Project", count: 2 }],
	},
	subagents: [{ agentId: "ag1", agentType: "Explore", description: "find tests", turnSeq: 1, toolCalls: 3 }],
	compactions: [{ ts: new Date(2026, 8, 26, 11, 45).toISOString(), trigger: "manual", afterTurnSeq: 1 }],
	review: null,
	...over,
});

/** The session rows (the filter dropdowns have options of their own). */
const rows = () => within(screen.getByRole("listbox", { name: "Sessions" })).getAllByRole("option");

let log: URL[];
let detailFor: (id: string) => SessionDetail;
let failingDetail = new Set<string>();
let firstRun = false;
beforeEach(() => {
	observed = [];
	vi.stubGlobal("IntersectionObserver", FakeObserver);
	detailFor = (id) => detail(id);
	failingDetail = new Set();
	firstRun = false;
	log = mockFetch([
		(u) =>
			firstRun && u.pathname === "/api/sessions" ? { body: { items: [], total: 0, nextCursor: null } } : undefined,
		(u) =>
			failingDetail.has(u.pathname)
				? { status: 500, body: { error: { code: "internal", message: "boom" } } }
				: undefined,
		route("/api/status", () => statusFixture(firstRun ? { lastIngestAt: null } : {})),
		route("/api/repos", { repos: [] }),
		route("/api/sessions", (u: URL) =>
			u.searchParams.get("cursor") === "c2"
				? page(["s-3"], null)
				: {
						...page(["s-1", "s-2"], "c2"),
						items: [
							sessionItem("s-1", { inProgress: true, endedAt: null, durationSec: null, summaryLine: "Running work" }),
							sessionItem("s-2", { imported: true, summaryLine: "Old work", type: "bugfix" }),
						],
					},
		),
		(u) => {
			const m = /^\/api\/sessions\/([^/]+)$/.exec(u.pathname);
			return m ? { body: detailFor(m[1]) } : undefined;
		},
	]);
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("Sessions list", () => {
	it("renders rows with their badges and the header count", async () => {
		at("/sessions");
		render(<App />);
		expect(await screen.findByText("Running work")).toBeTruthy();
		expect(screen.getByText("3 sessions · 7 days")).toBeTruthy();
		const list = rows();
		expect(list).toHaveLength(2);
		expect(within(list[0]).getByText("In progress")).toBeTruthy();
		expect(within(list[1]).getByText("imported")).toBeTruthy();
		expect(within(list[1]).getByText("bugfix")).toBeTruthy();
		expect(within(list[0]).queryByText("feature")).toBeNull();
	});

	it("moves the selection with the arrow keys and puts it in the URL", async () => {
		at("/sessions/s-1");
		render(<App />);
		const list = await screen.findByRole("listbox", { name: "Sessions" });
		await screen.findByText("Old work");
		fireEvent.keyDown(list, { key: "ArrowDown" });
		await waitFor(() => expect(window.location.pathname).toBe("/sessions/s-2"));
		expect(rows()[1].getAttribute("aria-selected")).toBe("true");
		fireEvent.keyDown(list, { key: "ArrowUp" });
		await waitFor(() => expect(window.location.pathname).toBe("/sessions/s-1"));
	});

	it("moves with the arrow keys without adding a history entry per row", async () => {
		at("/sessions/s-1");
		render(<App />);
		const list = await screen.findByRole("listbox", { name: "Sessions" });
		await screen.findByText("Old work");
		const before = window.history.length;
		fireEvent.keyDown(list, { key: "ArrowDown" });
		await waitFor(() => expect(window.location.pathname).toBe("/sessions/s-2"));
		expect(window.history.length).toBe(before);
	});

	it("shows the first-run state with the doctor command", async () => {
		firstRun = true;
		at("/sessions");
		render(<App />);
		expect(await screen.findByText("No sessions captured yet")).toBeTruthy();
		expect(screen.getByText("cc-debrief doctor")).toBeTruthy();
	});

	it("searches once typing stops", async () => {
		at("/sessions");
		render(<App />);
		await screen.findByText("Running work");
		const user = userEvent.setup();
		await user.type(screen.getByPlaceholderText("Search prompts and summaries"), "alembic");
		await waitFor(() => expect(log.filter((u) => u.searchParams.get("q") === "alembic")).toHaveLength(1));
		await new Promise((r) => setTimeout(r, 400));
		expect(
			log.filter((u) => u.pathname === "/api/sessions" && (u.searchParams.get("q") ?? "").length > 0),
		).toHaveLength(1);
	});

	it("loads the next page when the end of the list scrolls into view", async () => {
		at("/sessions");
		render(<App />);
		await screen.findByText("Running work");
		await scrollToEnd();
		expect(await screen.findByText("Session s-3")).toBeTruthy();
		expect(rows()).toHaveLength(3);
		expect(log.some((u) => u.searchParams.get("cursor") === "c2")).toBe(true);
	});
});

describe("Sessions list live refresh", () => {
	it("keeps loaded pages and adds new sessions on top when new lines are ingested", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		let ingest = "2026-10-02T10:00:00.000Z";
		let fresh = false;
		mockFetch([
			route("/api/status", () => statusFixture({ pollSeconds: 5, lastIngestAt: ingest })),
			route("/api/repos", { repos: [] }),
			route("/api/sessions", (u: URL) =>
				u.searchParams.get("cursor") === "c2"
					? page(["s-3"], null)
					: fresh
						? { items: [sessionItem("s-new"), sessionItem("s-1"), sessionItem("s-2")], total: 4, nextCursor: "c2" }
						: page(["s-1", "s-2"], "c2"),
			),
		]);
		at("/sessions");
		render(<App />);
		await screen.findByText("Session s-1");
		await scrollToEnd();
		await screen.findByText("Session s-3");
		fresh = true;
		ingest = "2026-10-02T10:00:15.000Z";
		await act(async () => {
			await vi.advanceTimersByTimeAsync(5_100);
		});
		await screen.findByText("Session s-new");
		expect(rows().map((r) => r.id)).toEqual(["session-s-new", "session-s-1", "session-s-2", "session-s-3"]);
		expect(screen.getByText("4 sessions · 7 days")).toBeTruthy();
	});
});

describe("Session detail", () => {
	it("shows the header, chips with failure style, subagent chip, compaction marker and expanders", async () => {
		at("/sessions/s-1");
		render(<App />);
		expect(await screen.findByText(/Sat 26 Sep · 11:40–12:52 · VS Code ·/)).toBeTruthy();
		expect(screen.getByText("Timeline · 6 turns · 31 tool calls")).toBeTruthy();
		expect(screen.getByText("Grep ×4 · 2.1s")).toBeTruthy();
		expect(screen.getByText("mcp__github__search_code · 1.8s")).toBeTruthy();
		const failed = screen.getByText("Bash pytest ×3 · 41s · failed ×3");
		expect(failed.closest("[data-failed]")?.getAttribute("data-failed")).toBe("true");
		expect(screen.getByText("subagent: Explore")).toBeTruthy();
		expect(screen.getByText(/Compacted · manual/)).toBeTruthy();
		expect(screen.getByText("Summary pending")).toBeTruthy();
		// Only the first two turns until expanded.
		expect(screen.queryByText("Prompt number 3")).toBeNull();
		await userEvent.click(screen.getByRole("button", { name: "4 more turns…" }));
		expect(screen.getByText("Prompt number 6")).toBeTruthy();
		// Side facts.
		expect(screen.getByText("38k")).toBeTruthy();
		expect(screen.getByText("$2.10")).toBeTruthy();
		expect(screen.queryByText("src/g.ts")).toBeNull();
		await userEvent.click(screen.getByRole("button", { name: "2 more files" }));
		expect(screen.getByText("src/g.ts")).toBeTruthy();
		// Used: skills, MCP servers and tools with call counts (×N above 1) and failures, then instruction files.
		const used = within(screen.getByRole("region", { name: "Used" }));
		expect(used.getByText("Skills")).toBeTruthy();
		expect(used.getByText("code-review")).toBeTruthy();
		expect(used.getByText("MCP")).toBeTruthy();
		expect(used.getByText("github ×3 · 1 failed")).toBeTruthy();
		expect(used.getByText("Tools")).toBeTruthy();
		expect(used.getByText("Read ×12")).toBeTruthy();
		expect(used.getByText("Bash ×5 · 2 failed")).toBeTruthy();
		expect(used.getByText("Instructions")).toBeTruthy();
		expect(used.getByText("CLAUDE.md ×2")).toBeTruthy();
	});

	it("leaves out empty Used groups", async () => {
		detailFor = (id) =>
			detail(id, {
				used: { skills: [], mcpServers: [], tools: [{ name: "Read", calls: 1, failures: 0 }], instructionFiles: [] },
			});
		at("/sessions/s-1");
		render(<App />);
		const used = within(await screen.findByRole("region", { name: "Used" }));
		expect(used.getByText("Read")).toBeTruthy();
		expect(used.queryByText("Skills")).toBeNull();
		expect(used.queryByText("MCP")).toBeNull();
		expect(used.queryByText("Instructions")).toBeNull();
	});

	it("shows the error, not the previous session, when the next session fails to load", async () => {
		failingDetail.add("/api/sessions/s-2");
		at("/sessions/s-1");
		render(<App />);
		const list = await screen.findByRole("listbox", { name: "Sessions" });
		expect(await screen.findByRole("button", { name: "claude --resume" })).toBeTruthy();
		fireEvent.keyDown(list, { key: "ArrowDown" });
		await waitFor(() => expect(window.location.pathname).toBe("/sessions/s-2"));
		expect(await screen.findByText("Could not load this panel")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "claude --resume" })).toBeNull();
	});

	it("starts the next session with its turns and files collapsed", async () => {
		at("/sessions/s-1");
		render(<App />);
		await userEvent.click(await screen.findByRole("button", { name: "4 more turns…" }));
		expect(screen.getByText("Prompt number 6")).toBeTruthy();
		fireEvent.keyDown(screen.getByRole("listbox", { name: "Sessions" }), { key: "ArrowDown" });
		await waitFor(() => expect(window.location.pathname).toBe("/sessions/s-2"));
		expect(await screen.findByRole("button", { name: "4 more turns…" })).toBeTruthy();
		expect(screen.queryByText("Prompt number 6")).toBeNull();
	});

	it("lists denials on a chip without marking it failed", () => {
		render(<ToolChip tool={{ label: "Write", count: 1, totalMs: 5000, failures: 0, denials: 1 }} />);
		const chip = screen.getByText("Write · 5.0s · denied ×1");
		expect(chip.getAttribute("data-failed")).toBe("false");
	});

	it("says tokens unknown when the session has no usage", async () => {
		detailFor = (id) =>
			detail(id, {
				tokens: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, costUsd: null, byModel: [], unknown: true },
			});
		at("/sessions/s-1");
		render(<App />);
		expect(await screen.findByText("tokens unknown")).toBeTruthy();
	});

	it("copies the resume command", async () => {
		const writeText = vi.fn(async () => {});
		Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
		at("/sessions/s-1");
		render(<App />);
		await userEvent.click(await screen.findByRole("button", { name: "claude --resume" }));
		expect(writeText).toHaveBeenCalledWith("claude --resume s-1");
		expect(await screen.findByText("Copied")).toBeTruthy();
	});

	it("shows a running session as running and refetches it when new lines are ingested", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		let ingest = "2026-10-02T10:00:00.000Z";
		log = mockFetch([
			route("/api/status", () => statusFixture({ pollSeconds: 5, lastIngestAt: ingest })),
			route("/api/repos", { repos: [] }),
			route("/api/sessions", page(["s-1"], null, 1)),
			(u) =>
				u.pathname === "/api/sessions/s-1"
					? { body: detail("s-1", { inProgress: true, endedAt: null, durationSec: null }) }
					: undefined,
		]);
		at("/sessions/s-1");
		render(<App />);
		expect(await screen.findByText(/11:40 · running/)).toBeTruthy();
		const before = log.filter((u) => u.pathname === "/api/sessions/s-1").length;
		ingest = "2026-10-02T10:00:15.000Z";
		await act(async () => {
			await vi.advanceTimersByTimeAsync(5_100);
		});
		await waitFor(() => expect(log.filter((u) => u.pathname === "/api/sessions/s-1").length).toBeGreaterThan(before));
	});
});

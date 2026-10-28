import type { RepoDetail, RepoRow } from "@api-types";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../ui/src/app";
import { remoteLabel } from "../../ui/src/components/RepoTable";
import { at, mockFetch, route, statusFixture } from "./helpers";

const repo = (id: string, name: string, over: Partial<RepoRow> = {}): RepoRow => ({
	id,
	name,
	remoteUrl: `https://${id}.git`,
	branch: "main",
	branchesSeen: 1,
	sessions: 24,
	tokens: 3_100_000,
	costUsd: 15.6,
	linesAdded: 1910,
	linesRemoved: 480,
	repoSkillsUsed: 1,
	repoSkillsAvailable: 1,
	repoMcp: [],
	...over,
});
const APP = "github.com/me/app";
const repos: RepoRow[] = [
	repo(APP, "app", {
		branchesSeen: 3,
		sessions: 61,
		tokens: 9_400_000,
		costUsd: 44.1,
		linesAdded: 6820,
		linesRemoved: 2140,
		repoSkillsUsed: 2,
		repoSkillsAvailable: 4,
		repoMcp: ["postgres", "github"],
	}),
	repo("/home/me/scratch", "scratch", { remoteUrl: null, repoSkillsUsed: 0, repoSkillsAvailable: 0 }),
];
const detail: RepoDetail = {
	repo: repos[0],
	files: [
		{ path: "services/licensing/service.py", sessions: 14, added: 410, removed: 20 },
		{ path: "tests/test_cache.py", sessions: 8, added: 510, removed: 0 },
	],
	typeMix: [],
	items: [
		{
			kind: "skill",
			name: "conventions",
			source: "app/.claude/skills",
			lazy: false,
			invoked: 22,
			loaded: 40,
			used: true,
		},
		{
			kind: "skill",
			name: "migration-check",
			source: "app/.claude/skills",
			lazy: false,
			invoked: 0,
			loaded: 40,
			used: false,
		},
		{ kind: "skill", name: "test-writer", source: "app/.claude/skills", lazy: true, invoked: 6, loaded: 9, used: true },
		{ kind: "mcp", name: "postgres", source: "app/.mcp.json", lazy: false, tools: 3, calls: 31, used: true },
		{ kind: "instructions", name: "CLAUDE.md", source: "app", lazy: false, loaded: 61, used: true },
	],
	suggestions: [],
	languages: [],
	branches: [],
	used: { skills: [], mcpServers: [], agentTypes: [] },
	topTools: [],
	perWeek: [],
};

let log: URL[];
let list: RepoRow[];
beforeEach(() => {
	list = repos;
	log = mockFetch([
		route("/api/status", statusFixture()),
		route("/api/repos", () => ({ repos: list })),
		(u) => (u.pathname === `/api/repos/${encodeURIComponent(APP)}` ? { body: detail } : undefined),
	]);
});
afterEach(() => vi.unstubAllGlobals());

describe("Repos", () => {
	it("lists repos with branches, remote, totals, lines, repo skills and MCP", async () => {
		at("/repos");
		render(<App />);
		const row = (await screen.findByText("app")).closest("tr") as HTMLElement;
		expect(within(row).getByText("main · 3 branches seen")).toBeTruthy();
		expect(within(row).getByText(APP)).toBeTruthy();
		expect(within(row).getByText("61")).toBeTruthy();
		expect(within(row).getByText("9.4M")).toBeTruthy();
		expect(within(row).getByText("$44.10")).toBeTruthy();
		expect(within(row).getByText("+6,820")).toBeTruthy();
		expect(within(row).getByText("−2,140")).toBeTruthy();
		expect(within(row).getByText("2 / 4")).toBeTruthy();
		expect(within(row).getByText("postgres, github")).toBeTruthy();
		const scratch = screen.getByText("scratch").closest("tr") as HTMLElement;
		expect(within(scratch).getByText("no remote")).toBeTruthy();
		expect(within(scratch).getByText("—")).toBeTruthy();
		expect(screen.queryByRole("combobox", { name: "Repo" })).toBeNull(); // no repo filter on Repos
	});

	it("selecting a repo puts it in the URL and loads its panels", async () => {
		at("/repos");
		render(<App />);
		await userEvent.click(await screen.findByText("app"));
		await waitFor(() => expect(window.location.pathname).toBe(`/repos/${encodeURIComponent(APP)}`));
		expect(await screen.findByText("app · most edited files")).toBeTruthy();
		expect(screen.getByText("services/licensing/service.py")).toBeTruthy();
		expect(screen.getByText("14 sessions · +410")).toBeTruthy();
		expect(screen.queryByText(/Session types here/)).toBeNull();
		expect(
			within(screen.getByRole("table", { name: "Repos" }))
				.getByText("app")
				.closest("tr")
				?.getAttribute("aria-current"),
		).toBe("true");
	});

	it("shows repo-level items with lazy labels and badge variants", async () => {
		at(`/repos/${encodeURIComponent(APP)}`);
		render(<App />);
		expect(await screen.findByText("Repo-level skills & MCP")).toBeTruthy();
		expect(screen.getByText("22 invoked").className).toMatch(/text-good/);
		expect(screen.getByText("never").className).toMatch(/text-bad/);
		expect(screen.getByText("app/.claude/skills (lazy)")).toBeTruthy();
		expect(screen.getByText("app/.mcp.json · 3 tools")).toBeTruthy();
		expect(screen.getByText("31 calls")).toBeTruthy();
		expect(screen.getByText("loaded 61×")).toBeTruthy();
		expect(log.some((u) => u.pathname === `/api/repos/${encodeURIComponent(APP)}`)).toBe(true);
	});

	it("shows an empty state without repos", async () => {
		list = [];
		at("/repos");
		render(<App />);
		expect(await screen.findByText("No repos in this range")).toBeTruthy();
	});

	it("shows the first-run state with the doctor command", async () => {
		list = [];
		mockFetch([route("/api/status", statusFixture({ lastIngestAt: null })), route("/api/repos", { repos: [] })]);
		at("/repos");
		render(<App />);
		expect(await screen.findByText("No sessions captured yet")).toBeTruthy();
		expect(screen.getByText("cc-debrief doctor")).toBeTruthy();
	});

	it("shows the error, not the previous repo's files, when the next repo fails to load", async () => {
		at(`/repos/${encodeURIComponent(APP)}`);
		render(<App />);
		expect(await screen.findByText("app · most edited files")).toBeTruthy();
		// scratch has no mock, so its detail request fails with 404.
		await userEvent.click(screen.getByText("scratch"));
		expect(await screen.findByText("Could not load this panel")).toBeTruthy();
		expect(screen.queryByText("app · most edited files")).toBeNull();
	});
});

describe("remoteLabel", () => {
	it("shows host/org/repo for https, ssh and scp-style remotes", () => {
		expect(remoteLabel("https://github.com/me/app.git")).toBe("github.com/me/app");
		expect(remoteLabel("git@github.com:me/app.git")).toBe("github.com/me/app");
		expect(remoteLabel("github.com:me/app.git")).toBe("github.com/me/app");
		expect(remoteLabel("ssh://git@host:2222/me/app.git")).toBe("host:2222/me/app");
		expect(remoteLabel(null)).toBe("no remote");
	});
});

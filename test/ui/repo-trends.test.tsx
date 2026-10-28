// Phase 7 Task 11 (P9 + P12): Repo detail trends and the repo's memory files (Markdown viewer, read-only).
import type { MemoryFileResponse, MemoryListResponse, RepoDetail, RepoRow } from "@api-types";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../ui/src/app";
import { at, mockFetch, route, statusFixture } from "./helpers";

const APP = "github.com/me/app";
const ENC = encodeURIComponent(APP);
const row: RepoRow = {
	id: APP,
	name: "app",
	remoteUrl: null,
	branch: "main",
	branchesSeen: 2,
	sessions: 5,
	tokens: 1000,
	costUsd: 3,
	linesAdded: 10,
	linesRemoved: 2,
	repoSkillsUsed: 0,
	repoSkillsAvailable: 0,
	repoMcp: [],
};
const detail: RepoDetail = {
	repo: row,
	files: [],
	typeMix: [],
	items: [],
	suggestions: [],
	languages: [
		{ language: "typescript", lines: 450 },
		{ language: "markdown", lines: 50 },
	],
	branches: [
		{ name: "main", sessions: 4 },
		{ name: "feat/x", sessions: 1 },
	],
	used: {
		skills: [{ name: "pdf", count: 2 }],
		mcpServers: [{ name: "github", count: 7 }],
		agentTypes: [{ name: "Explore", count: 3 }],
	},
	topTools: [
		{ name: "Bash", calls: 40 },
		{ name: "Edit", calls: 12 },
	],
	perWeek: [
		{ week: "2026-10-05", sessions: 2, usd: 1.5 },
		{ week: "2026-10-12", sessions: 3, usd: 1.5 },
	],
};
const files: MemoryListResponse = {
	files: [
		{ name: "MEMORY.md", size: 900, mtime: "2026-10-16T10:00:00.000Z", truncated: false },
		{ name: "big.md", size: 70_000, mtime: "2026-10-15T10:00:00.000Z", truncated: true },
	],
};
const file = (name: string): MemoryFileResponse => ({
	name,
	text: name === "big.md" ? "# Big\n\nlots" : "# Memory\n\n- [Phase 7](phase-7.md) — parity",
	truncated: name === "big.md",
});

beforeEach(() => {
	at(`/repos/${encodeURIComponent(APP)}`);
	mockFetch([
		route("/api/status", statusFixture()),
		route("/api/repos", { repos: [row] }),
		route(`/api/repos/${ENC}`, detail),
		route(`/api/repos/${ENC}/memory`, files),
		(u) =>
			u.pathname.startsWith(`/api/repos/${ENC}/memory/`)
				? { body: file(decodeURIComponent(u.pathname.split("/").at(-1) as string)) }
				: undefined,
	]);
});
afterEach(() => vi.unstubAllGlobals());

describe("Repo detail trends", () => {
	it("shows languages, branches, what was used, top tools and the weekly trend", async () => {
		render(<App />);
		const trends = within(await screen.findByRole("region", { name: "Repo trends" }));
		expect(trends.getByText("typescript")).toBeTruthy();
		expect(trends.getByText("90%")).toBeTruthy(); // 450 of 500 lines
		expect(trends.getByText("feat/x")).toBeTruthy();
		expect(trends.getByText("github ×7")).toBeTruthy();
		expect(trends.getByText("Explore ×3")).toBeTruthy();
		expect(trends.getByText("pdf ×2")).toBeTruthy();
		expect(trends.getByText("Bash")).toBeTruthy();
		const weeks = within(trends.getByRole("table", { name: "Sessions and cost per week" }));
		expect(weeks.getAllByRole("row")).toHaveLength(3);
	});
});

describe("Memory files", () => {
	it("lists the files and opens one as Markdown, read-only", async () => {
		render(<App />);
		const mem = within(await screen.findByRole("region", { name: "Memory files" }));
		expect(await mem.findByText("MEMORY.md")).toBeTruthy();
		await userEvent.click(mem.getByRole("button", { name: "MEMORY.md" }));
		await waitFor(() => expect(mem.getByRole("heading", { name: "Memory" })).toBeTruthy());
		expect(mem.queryByRole("textbox")).toBeNull();
		await userEvent.click(mem.getByRole("button", { name: "big.md" }));
		expect(await mem.findByText("cut at 64 KB")).toBeTruthy();
	});
});

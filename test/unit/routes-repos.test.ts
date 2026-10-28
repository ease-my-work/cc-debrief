import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../src/db/adapter";
import { getRepoDetail, listRepos } from "../../src/db/queries/repos";
import { createApp } from "../../src/server/app";
import type { ApiError, RepoDetail, ReposResponse } from "../../src/server/types";
import { seedDb } from "../helpers/seed";
import { at, REPO_API, REPO_APP, S, SMALL_NOW, seedSmall, seedSmallInventory } from "../helpers/seed-small";
import { type TmpHome, tmpHome } from "../helpers/tmp-home";

let h: TmpHome;
let db: Db;
beforeEach(() => {
	h = tmpHome();
	db = seedDb();
	seedSmall(db);
	seedSmallInventory(db);
	// Routes read the real clock: pin it to the fixture's NOW so range windows stay put.
	vi.useFakeTimers({ now: SMALL_NOW, toFake: ["Date"] });
});
afterEach(() => {
	vi.useRealTimers();
	db.close();
	h.cleanup();
});

describe("listRepos", () => {
	it("lists repos with sessions in range, most sessions first, excluding sessions without a repo", () => {
		expect(listRepos(db, { range: "30d", now: SMALL_NOW })).toEqual([
			{
				id: REPO_APP,
				name: "app",
				remoteUrl: "https://github.com/me/app.git",
				branch: "main",
				branchesSeen: 1,
				sessions: 3,
				tokens: 2100,
				costUsd: 0.15,
				linesAdded: 18,
				linesRemoved: 3,
				repoSkillsUsed: 1,
				repoSkillsAvailable: 2,
				repoMcp: ["tracker"],
			},
			{
				id: REPO_API,
				name: "api",
				remoteUrl: null,
				branch: "main",
				branchesSeen: 2,
				sessions: 2,
				tokens: 4000,
				costUsd: 2,
				linesAdded: 140,
				linesRemoved: 0,
				repoSkillsUsed: 0,
				repoSkillsAvailable: 1,
				repoMcp: [],
			},
		]);
	});

	it("honours the range", () => {
		expect(listRepos(db, { range: "7d", now: SMALL_NOW }).map((r) => [r.id, r.sessions])).toEqual([
			[REPO_APP, 3],
			[REPO_API, 1],
		]);
	});
});

describe("getRepoDetail", () => {
	it("returns top files, repo items with lazy flags and CLAUDE.md loads, and no suggestions", () => {
		const d = getRepoDetail(db, REPO_APP, { range: "30d", now: SMALL_NOW }) as RepoDetail;
		expect(d.repo.id).toBe(REPO_APP);
		expect(d.files).toEqual([
			{ path: "src/a.ts", sessions: 1, added: 10, removed: 2 },
			{ path: "src/b.ts", sessions: 1, added: 5, removed: 0 },
			{ path: "README.md", sessions: 1, added: 3, removed: 1 },
		]);
		expect(d.items).toEqual([
			{ kind: "skill", name: "deploy", source: "app/.claude/skills", lazy: false, invoked: 1, loaded: 3, used: true },
			{ kind: "skill", name: "demo", source: "app/.claude/skills", lazy: true, invoked: 0, loaded: 1, used: false },
			{ kind: "mcp", name: "tracker", source: "app/.mcp.json", lazy: false, tools: 0, calls: 0, used: false },
			{ kind: "instructions", name: "CLAUDE.md", source: "app", lazy: false, loaded: 2, used: true },
		]);
		expect(d.typeMix).toEqual([]);
		expect(d.suggestions).toEqual([]);
	});

	it("counts a repo MCP server's tools and calls from this repo's sessions only", () => {
		// The api repo's session (s2) calls a server of the same name.
		db.prepare(
			`INSERT INTO tool_calls (session_id, tool_use_id, tool_name, mcp_server, mcp_source, mcp_tool, ok)
			 VALUES (?, 'tu-t', 'mcp__tracker__list', 'tracker', NULL, 'list', 1)`,
		).run(S.s2);
		const d = getRepoDetail(db, REPO_APP, { range: "30d", now: SMALL_NOW }) as RepoDetail;
		expect(d.items.find((i) => i.name === "tracker")).toMatchObject({ tools: 0, calls: 0 });
	});

	it("matches a repo MCP server's calls by name case-insensitively, as feature 03 does (review A5)", () => {
		db.prepare(
			`INSERT INTO tool_calls (session_id, tool_use_id, tool_name, mcp_server, mcp_source, mcp_tool, ok)
			 VALUES (?, 'tu-c', 'mcp__Tracker__list', 'Tracker', NULL, 'list', 1)`,
		).run(S.s1);
		const d = getRepoDetail(db, REPO_APP, { range: "30d", now: SMALL_NOW }) as RepoDetail;
		expect(d.items.find((i) => i.name === "tracker")).toMatchObject({ tools: 1, calls: 1 });
	});

	it("keeps ~/.claude.json repo MCP servers, which the user scan (not the repo scan) refreshes", () => {
		// The user scan runs before the repo scan, so these rows are always older than last_scan_repo.
		const userScan = at(10, 2, 8);
		db.prepare("UPDATE meta SET value = ? WHERE key = 'last_scan_user'").run(userScan);
		db.prepare(
			`INSERT INTO inventory (scope, repo_id, kind, name, path, first_seen, last_seen, meta)
			 VALUES ('repo', ?, 'mcp', 'pg', '/home/me/.claude.json', ?, ?, '{"source":"claude.json"}')`,
		).run(REPO_APP, userScan, userScan);
		expect(listRepos(db, { range: "30d", now: SMALL_NOW })[0].repoMcp).toEqual(["pg", "tracker"]);
		const d = getRepoDetail(db, REPO_APP, { range: "30d", now: SMALL_NOW }) as RepoDetail;
		expect(d.items.filter((i) => i.kind === "mcp").map((i) => [i.name, i.source])).toEqual([
			["pg", "app (~/.claude.json)"],
			["tracker", "app/.mcp.json"],
		]);
	});

	it("returns null for an unknown repo", () => {
		expect(getRepoDetail(db, "github.com/no/such", { range: "30d", now: SMALL_NOW })).toBeNull();
	});
});

describe("repos routes", () => {
	const get = (path: string) =>
		createApp(db, { port: 4242, uiDir: "/x" }).request(path, { headers: { host: "localhost:4242" } });

	it("GET /api/repos defaults to 30 days", async () => {
		const body = (await (await get("/api/repos")).json()) as ReposResponse;
		expect(body.repos.map((r) => r.id)).toEqual([REPO_APP, REPO_API]);
	});

	it("decodes a URL-encoded repo id, and 404s an unknown one", async () => {
		const r = await get(`/api/repos/${encodeURIComponent(REPO_APP)}`);
		expect(r.status).toBe(200);
		expect(((await r.json()) as RepoDetail).repo.name).toBe("app");
		const missing = await get(`/api/repos/${encodeURIComponent("github.com/Org/Repo")}`);
		expect(missing.status).toBe(404);
		expect(((await missing.json()) as ApiError).error.code).toBe("not_found");
	});

	it("rejects a bad range with 400", async () => {
		expect((await get("/api/repos?range=year")).status).toBe(400);
	});
});

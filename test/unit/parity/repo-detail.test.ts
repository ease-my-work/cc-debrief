// Phase 7 Task 11 (P9 + P12 memory): repo trends on the Repo detail and the repo's auto-memory files (read live).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listMemoryFiles, projectSlug, readMemoryFile } from "../../../src/collector/memory";
import type { Db } from "../../../src/db/adapter";
import { getRepoDetail } from "../../../src/db/queries/repos";
import { createApp } from "../../../src/server/app";
import { localAt, PARITY_NOW, seedParitySession } from "../../helpers/parity-seed";
import { seedDb } from "../../helpers/seed";
import { type TmpHome, tmpHome } from "../../helpers/tmp-home";

const REPO = { id: "github.com/acme/api", name: "api", root: "/home/u/code/api" };

let h: TmpHome;
let db: Db;
beforeEach(() => {
	h = tmpHome();
	db = seedDb();
});
afterEach(() => {
	db.close();
	h.cleanup();
});

let n = 0;
function session(
	at: Date,
	o: { branch?: string; usd?: number; tools?: [string, string | null, string | null][]; agent?: string } = {},
) {
	const id = `s${n++}`;
	seedParitySession(db, id, { startedAt: at.toISOString(), repo: REPO, usage: [{ input: 100, cost: o.usd ?? 1 }] });
	if (o.branch) db.prepare("UPDATE sessions SET branch = ? WHERE session_id = ?").run(o.branch, id);
	for (const [tool, mcp, skill] of o.tools ?? [])
		db.prepare(
			"INSERT INTO tool_calls (session_id, tool_name, mcp_server, skill_name, ok, started_at) VALUES (?, ?, ?, ?, 1, ?)",
		).run(id, tool, mcp, skill, at.toISOString());
	if (o.agent)
		db.prepare("INSERT INTO subagents (session_id, agent_id, agent_type) VALUES (?, ?, ?)").run(id, `${id}-a`, o.agent);
	return id;
}

describe("getRepoDetail trends", () => {
	it("languages come from file_changes, branches from sessions", () => {
		const a = session(new Date(localAt(1)), { branch: "main" });
		const b = session(new Date(localAt(2)), { branch: "feat/x" });
		session(new Date(localAt(3)), { branch: "main" });
		const change = db.prepare(
			"INSERT INTO file_changes (session_id, repo_id, path, lines_added, lines_removed, language) VALUES (?, ?, ?, ?, ?, ?)",
		);
		change.run(a, REPO.id, "src/a.ts", 30, 10, "typescript");
		change.run(b, REPO.id, "src/b.ts", 5, 0, "typescript");
		change.run(b, REPO.id, "README.md", 7, 1, "markdown");
		change.run(b, REPO.id, "x.bin", 1, 0, null);
		const d = getRepoDetail(db, REPO.id, { range: "7d", now: PARITY_NOW });
		expect(d?.languages).toEqual([
			{ language: "typescript", lines: 45 },
			{ language: "markdown", lines: 8 },
		]);
		expect(d?.branches).toEqual([
			{ name: "main", sessions: 2 },
			{ name: "feat/x", sessions: 1 },
		]);
	});

	it("lists skills, MCP servers and subagent types used, and the top tools", () => {
		session(new Date(localAt(1)), {
			tools: [
				["Bash", null, null],
				["Bash", null, null],
				["Read", null, null],
				["Skill", null, "pdf"],
				["mcp__gh__issue", "gh", null],
			],
			agent: "Explore",
		});
		const d = getRepoDetail(db, REPO.id, { range: "7d", now: PARITY_NOW });
		expect(d?.used).toEqual({
			skills: [{ name: "pdf", count: 1 }],
			mcpServers: [{ name: "gh", count: 1 }],
			agentTypes: [{ name: "Explore", count: 1 }],
		});
		expect(d?.topTools).toEqual([
			{ name: "Bash", calls: 2 },
			{ name: "Read", calls: 1 },
			{ name: "Skill", calls: 1 },
		]);
	});

	it("sessions and cost per week, weeks starting Monday local, empty weeks included", () => {
		// PARITY_NOW is Saturday 2026-10-17: its week starts Monday 2026-10-12.
		session(new Date(2026, 9, 12, 0, 30), { usd: 2 }); // Monday, first minutes
		session(new Date(2026, 9, 11, 23, 30), { usd: 3 }); // the Sunday before: previous week
		session(new Date(2026, 8, 28, 9), { usd: 5 }); // two weeks earlier
		const d = getRepoDetail(db, REPO.id, { range: "30d", now: PARITY_NOW });
		expect(d?.perWeek.slice(-3)).toEqual([
			{ week: "2026-09-28", sessions: 1, usd: 5 },
			{ week: "2026-10-05", sessions: 1, usd: 3 },
			{ week: "2026-10-12", sessions: 1, usd: 2 },
		]);
		expect(d?.perWeek[0].week).toBe("2026-09-14");
	});
});

describe("weekly trend across a DST change (final review)", () => {
	it("never skips a week when the range starts late on a Sunday before a clock change", () => {
		// America/Los_Angeles moves clocks forward on 2026-03-08; 7 × 24 h from Sun 23:30 lands on Monday 00:30.
		session(new Date(2026, 2, 1, 23, 30)); // the first session: "all" starts here
		session(new Date(2026, 2, 4, 10)); // Wednesday of the week of Mar 2
		session(new Date(2026, 2, 12, 10));
		const d = getRepoDetail(db, REPO.id, { range: "all", now: new Date(2026, 2, 20, 12) });
		expect(d?.perWeek.map((w) => [w.week, w.sessions])).toEqual([
			["2026-02-23", 1],
			["2026-03-02", 1],
			["2026-03-09", 1],
			["2026-03-16", 0],
		]);
	});
});

describe("memory files", () => {
	it("maps a repo root to its project folder like Claude Code does", () => {
		expect(projectSlug("C:\\Vipul\\Codebase\\my.repo")).toBe("C--Vipul-Codebase-my-repo");
		expect(projectSlug("/home/u/code/api")).toBe("-home-u-code-api");
	});

	const memDir = (root: string) => join(h.claude, "projects", projectSlug(root), "memory");

	it("lists *.md files with size and date; a missing folder is an empty list", () => {
		expect(listMemoryFiles(REPO.root)).toEqual([]);
		mkdirSync(memDir(REPO.root), { recursive: true });
		writeFileSync(join(memDir(REPO.root), "MEMORY.md"), "- [a](a.md)\n");
		writeFileSync(join(memDir(REPO.root), "a.md"), "x".repeat(70 * 1024));
		writeFileSync(join(memDir(REPO.root), "notes.txt"), "not memory");
		const files = listMemoryFiles(REPO.root);
		expect(files.map((f) => [f.name, f.size, f.truncated])).toEqual([
			["MEMORY.md", 12, false],
			["a.md", 70 * 1024, true],
		]);
		expect(files[0].mtime).toMatch(/^\d{4}-\d\d-\d\dT/);
	});

	it("reads a file, cut at 64 KB", () => {
		mkdirSync(memDir(REPO.root), { recursive: true });
		writeFileSync(join(memDir(REPO.root), "a.md"), "y".repeat(70 * 1024));
		const r = readMemoryFile(REPO.root, "a.md");
		expect(r?.truncated).toBe(true);
		expect(r?.text).toHaveLength(64 * 1024);
		expect(readMemoryFile(REPO.root, "missing.md")).toBeNull();
	});

	it("routes list and read; reject a name with a slash or ..", async () => {
		db.prepare("INSERT INTO repos (repo_id, root_path, name) VALUES (?, ?, ?)").run(REPO.id, REPO.root, REPO.name);
		mkdirSync(memDir(REPO.root), { recursive: true });
		writeFileSync(join(memDir(REPO.root), "MEMORY.md"), "# Memory\n");
		const app = createApp(db, { port: 4242, uiDir: "/x" });
		const get = (p: string) => app.request(p, { headers: { host: "localhost:4242" } });
		const id = encodeURIComponent(REPO.id);
		const list = await get(`/api/repos/${id}/memory`);
		expect(((await list.json()) as { files: { name: string }[] }).files.map((f) => f.name)).toEqual(["MEMORY.md"]);
		const read = await get(`/api/repos/${id}/memory/MEMORY.md`);
		expect(await read.json()).toEqual({ name: "MEMORY.md", text: "# Memory\n", truncated: false });
		for (const bad of ["..%2Fsecret.md", "a%2Fb.md", "a%5Cb.md", "x..md"])
			expect((await get(`/api/repos/${id}/memory/${bad}`)).status, bad).toBe(400);
		expect((await get(`/api/repos/${id}/memory/none.md`)).status).toBe(404);
		expect((await get(`/api/repos/nope/memory`)).status).toBe(404);
	});
});

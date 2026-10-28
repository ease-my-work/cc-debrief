import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanUser } from "../../src/collector/inventory";
import { runScan } from "../../src/commands/scan";
import { type Db, openDb } from "../../src/db/adapter";
import { migrate } from "../../src/db/migrate";
import { getMeta } from "../../src/db/queries/meta";
import { applyScan } from "../../src/derive/inventory-usage";
import { deriveSession } from "../../src/derive/session";
import { skillMd, standardUserTree, writeTree } from "../helpers/claude-tree";
import { gitRepo, type TestRepo } from "../helpers/git-repo";
import { runCaptured } from "../helpers/run-cli";
import { seedDb, storeLines } from "../helpers/seed";
import { type TmpHome, tmpHome } from "../helpers/tmp-home";

let h: TmpHome;
let repo: TestRepo;
let lines: string[];
const out = (l: string) => void lines.push(l);
beforeEach(() => {
	h = tmpHome();
	repo = gitRepo();
	lines = [];
});
afterEach(() => {
	repo.cleanup();
	h.cleanup();
});

function withTestDb<T>(fn: (db: Db) => T): T {
	const db = openDb();
	try {
		migrate(db);
		return fn(db);
	} finally {
		db.close();
	}
}

describe("cc-debrief scan", () => {
	it("prints the user and repo summary lines and stores both scopes", async () => {
		standardUserTree(h.claude);
		writeTree(repo.root, {
			".claude/skills/a/SKILL.md": skillMd("a", "startup"),
			"sub/.claude/skills/b/SKILL.md": skillMd("b", "lazy"),
			".mcp.json": { mcpServers: { tracker: { command: "t" } } },
		});
		await runScan({ path: join(repo.root, "sub"), out });
		expect(lines).toEqual([
			"user   2 skills · 2 plugin skills · 2 plugins · 2 MCP servers · 1 hook set",
			"repo   repo: 2 skills (1 lazy) · 1 MCP server · 0 hooks",
		]);
		withTestDb((db) => {
			expect(getMeta(db, "last_scan_user")).toEqual(expect.any(String));
			const repoId = db.prepare("SELECT repo_id FROM repos").get<{ repo_id: string }>()?.repo_id;
			expect(getMeta(db, `last_scan_repo:${repoId}`)).toEqual(expect.any(String));
			expect(
				db.prepare("SELECT name FROM inventory WHERE scope = 'repo' AND kind = 'skill' ORDER BY name").all(),
			).toEqual([{ name: "a" }, { name: "b" }]);
		});
	});

	it("notes a path outside any git repo and exits 0", async () => {
		const plain = join(h.claude, "..", "plain");
		mkdirSync(plain);
		const r = await runCaptured("scan", plain);
		expect(r.code).toBe(0);
		expect(r.stdout).toMatch(/^user {3}0 skills · 0 plugin skills · 0 plugins · 0 MCP servers · 0 hook sets$/m);
		expect(r.stdout).toMatch(/^repo {3}not a git repo: .*plain \(user level only\)$/m);
	});
});

describe("applyScan", () => {
	const SID = "22222222-0000-4000-8000-000000000002";
	const listingLines = (ts: string, names: string[]) => [
		{
			type: "attachment",
			uuid: `l-${ts}`,
			timestamp: ts,
			attachment: { type: "skill_listing", isInitial: true, names },
		},
		{ type: "user", uuid: `u-${ts}`, timestamp: ts, message: { role: "user", content: "hi" } },
	];
	const recent = () => new Date(Date.now() - 2 * 86_400_000).toISOString();

	it("turns a transcript-only row into the scanned row in place, keeping its usage history", () => {
		const db = seedDb();
		try {
			storeLines(db, SID, listingLines(recent(), ["ghost"]));
			deriveSession(db, SID);
			const before = db.prepare("SELECT id FROM inventory WHERE name = 'ghost'").get<{ id: number }>()?.id;
			writeTree(h.claude, { "skills/ghost/SKILL.md": skillMd("ghost", "Now installed") });
			applyScan(db, scanUser(), "user");
			const after = db
				.prepare("SELECT id, path, description, meta FROM inventory WHERE name = 'ghost'")
				.all<{ id: number; path: string; description: string; meta: string }>();
			expect(after).toHaveLength(1);
			expect(after[0]).toMatchObject({
				id: before,
				path: join(h.claude, "skills", "ghost"),
				description: "Now installed",
			});
			expect(JSON.parse(after[0].meta)).not.toHaveProperty("source");
			expect(db.prepare("SELECT inventory_id, loaded FROM inventory_usage WHERE session_id = ?").all(SID)).toEqual([
				{ inventory_id: before, loaded: 1 },
			]);
		} finally {
			db.close();
		}
	});

	it("moves a transcript-only row guessed at the wrong scope to the scanned repo scope", () => {
		const db = seedDb();
		try {
			storeLines(db, SID, listingLines(recent(), ["demo"]));
			deriveSession(db, SID);
			const id = db.prepare("SELECT id FROM inventory WHERE name = 'demo'").get<{ id: number }>()?.id;
			db.prepare("INSERT INTO repos (repo_id, root_path, name) VALUES ('r1', ?, 'repo')").run(repo.root);
			db.prepare("UPDATE sessions SET repo_id = 'r1' WHERE session_id = ?").run(SID);
			applyScan(
				db,
				[
					{
						scope: "repo",
						repoId: "r1",
						kind: "skill",
						name: "demo",
						path: "/r/demo",
						description: null,
						meta: { load: "lazy" },
					},
				],
				"repo:r1",
			);
			expect(db.prepare("SELECT id, scope, repo_id FROM inventory WHERE name = 'demo'").all()).toEqual([
				{ id, scope: "repo", repo_id: "r1" },
			]);
			expect(db.prepare("SELECT inventory_id, loaded FROM inventory_usage").all()).toEqual([
				{ inventory_id: id, loaded: 1 },
			]);
		} finally {
			db.close();
		}
	});

	it("leaves a transcript-only row that another repo's session uses where it is (review A7)", () => {
		const db = seedDb();
		try {
			storeLines(db, SID, listingLines(recent(), ["demo"]));
			deriveSession(db, SID);
			const id = db.prepare("SELECT id FROM inventory WHERE name = 'demo'").get<{ id: number }>()?.id;
			db.prepare("INSERT INTO repos (repo_id, root_path, name) VALUES ('ra', '/a', 'a'), ('rb', '/b', 'b')").run();
			db.prepare("UPDATE sessions SET repo_id = 'rb' WHERE session_id = ?").run(SID);
			const scanned = {
				scope: "repo" as const,
				repoId: "ra",
				kind: "skill" as const,
				name: "demo",
				path: "/a/demo",
				description: null,
				meta: {},
			};
			applyScan(db, [scanned], "repo:ra");
			const rows = db
				.prepare(
					"SELECT id, scope, repo_id, json_extract(meta, '$.source') AS source FROM inventory WHERE name = 'demo' ORDER BY id",
				)
				.all<{ id: number; scope: string; repo_id: string | null; source: string | null }>();
			expect(rows).toEqual([
				{ id, scope: "user", repo_id: null, source: "transcript" },
				{ id: expect.any(Number), scope: "repo", repo_id: "ra", source: null },
			]);
			// repo b's session still points at its own row, not at repo a's skill
			expect(db.prepare("SELECT inventory_id FROM inventory_usage WHERE session_id = ?").all(SID)).toEqual([
				{ inventory_id: id },
			]);
		} finally {
			db.close();
		}
	});

	it("re-derives usage for sessions of the last 30 days in the scanned scope only", () => {
		const db = seedDb();
		const OLD = "33333333-0000-4000-8000-000000000003";
		try {
			storeLines(db, SID, listingLines(recent(), ["fresh"]));
			storeLines(db, OLD, listingLines(new Date(Date.now() - 40 * 86_400_000).toISOString(), ["fresh"]));
			deriveSession(db, SID);
			deriveSession(db, OLD);
			// Both sessions hold a transcript-only "fresh"; drop their usage to see who gets rebuilt.
			db.prepare("DELETE FROM inventory_usage").run();
			const r = applyScan(
				db,
				[{ scope: "user", repoId: null, kind: "skill", name: "fresh", path: "/s/fresh", description: null, meta: {} }],
				"user",
			);
			expect(r.rederived).toBe(1);
			expect(db.prepare("SELECT session_id FROM inventory_usage").all()).toEqual([{ session_id: SID }]);
		} finally {
			db.close();
		}
	});
});

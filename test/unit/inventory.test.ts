import { mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	estimateContextTokens,
	type InventoryItem,
	scanRepo,
	scanUser,
	upsertInventory,
} from "../../src/collector/inventory";
import type { Db } from "../../src/db/adapter";
import { getMeta } from "../../src/db/queries/meta";
import { addPlugin, skillMd, standardUserTree, treeHash, writeTree } from "../helpers/claude-tree";
import { seedDb } from "../helpers/seed";
import { type TmpHome, tmpHome } from "../helpers/tmp-home";

let t: TmpHome;
let db: Db | undefined;
beforeEach(() => {
	t = tmpHome();
});
afterEach(() => {
	db?.close();
	db = undefined;
	t.cleanup();
});

const byKind = (items: InventoryItem[], kind: InventoryItem["kind"]) =>
	items.filter((i) => i.kind === kind).sort((a, b) => a.name.localeCompare(b.name));
const names = (items: InventoryItem[]) => items.map((i) => i.name);
const repoRoot = () => join(t.claude, "..", "repo");

describe("estimateContextTokens", () => {
	it("is ceil(chars / 4), 0 for null", () => {
		expect(estimateContextTokens("abcd")).toBe(1);
		expect(estimateContextTokens("abcde")).toBe(2);
		expect(estimateContextTokens("")).toBe(0);
		expect(estimateContextTokens(null)).toBe(0);
	});
});

describe("scanUser", () => {
	it("finds user skills, plugins with their skills, MCP servers and hooks, excluding our own hook", () => {
		standardUserTree(t.claude);
		const items = scanUser();

		const skills = byKind(items, "skill");
		expect(
			skills.filter((s) => s.scope === "user").map((s) => [s.name, s.description, s.meta.parseError ?? false]),
		).toEqual([
			["broken", null, true],
			["code-review", "Review a diff for bugs", false],
		]);
		expect(skills.find((s) => s.name === "code-review")?.path).toBe(join(t.claude, "skills", "code-review"));

		const pluginSkills = skills.filter((s) => s.scope === "plugin");
		expect(pluginSkills.map((s) => [s.name, s.meta.plugin])).toEqual([
			["oldtool:thing", "oldtool"],
			["superpowers:brainstorming", "superpowers"],
		]);

		const plugins = byKind(items, "plugin");
		expect(plugins.map((p) => [p.name, p.scope, p.meta.enabled, p.meta.marketplace])).toEqual([
			["oldtool", "plugin", false, "mkt"],
			["superpowers", "plugin", true, "mkt"],
		]);

		const mcp = byKind(items, "mcp");
		expect(mcp.map((m) => [m.name, m.scope, m.meta])).toEqual([
			["github", "user", { type: "stdio", command: "npx", args: ["-y", "gh-mcp"] }],
			["linear", "user", { type: "http", url: "https://mcp.example/mcp" }],
		]);

		const hooks = byKind(items, "hook");
		expect(hooks).toHaveLength(1);
		expect(hooks[0]).toMatchObject({
			scope: "user",
			meta: { event: "PreToolUse", matcher: "Bash", command: "echo checked" },
		});
		expect(JSON.stringify(items)).not.toContain("cc-debrief");
	});

	it("reads a plugin at its current installPath only, with its .mcp.json servers as plugin MCP items", () => {
		writeTree(t.claude, {
			"settings.json": { enabledPlugins: { "context7@official": true } },
			"plugins/cache/official/context7/0.9.0/.mcp.json": { old: { command: "old" } },
			"plugins/cache/official/context7/0.9.0/skills/stale/SKILL.md": skillMd("stale", "old version"),
		});
		addPlugin(t.claude, "context7@official", {
			version: "1.0.0",
			files: { ".mcp.json": { context7: { command: "npx", args: ["-y", "@upstash/context7-mcp"] } } },
		});
		const items = scanUser();
		expect(byKind(items, "plugin").map((p) => [p.name, p.meta.version])).toEqual([["context7", "1.0.0"]]);
		expect(byKind(items, "mcp").map((m) => [m.name, m.scope, m.meta.plugin, m.meta.command])).toEqual([
			["context7", "plugin", "context7", "npx"],
		]);
		expect(byKind(items, "skill")).toEqual([]);
	});

	it("reads plugin MCP servers wrapped in mcpServers or declared in plugin.json", () => {
		addPlugin(t.claude, "a@m", {
			files: { ".mcp.json": { mcpServers: { alpha: { type: "http", url: "https://a" } } } },
		});
		addPlugin(t.claude, "b@m", {
			files: { ".claude-plugin/plugin.json": { name: "b", mcpServers: { beta: { command: "b-server" } } } },
		});
		const mcp = byKind(scanUser(), "mcp");
		expect(mcp.map((m) => [m.name, m.meta.plugin, m.meta.type])).toEqual([
			["alpha", "a", "http"],
			["beta", "b", "stdio"],
		]);
	});

	it("never stores MCP env values or headers", () => {
		standardUserTree(t.claude);
		const mcp = byKind(scanUser(), "mcp");
		for (const m of mcp) {
			expect(m.meta).not.toHaveProperty("env");
			expect(m.meta).not.toHaveProperty("headers");
		}
		expect(JSON.stringify(mcp)).not.toContain("x-secret-token");
	});

	it("gives ~/.claude.json project MCP servers the repo_id of a known repo and skips unknown paths", () => {
		const root = repoRoot();
		writeTree(t.claude, {
			".claude.json": {
				projects: {
					[root.replaceAll("\\", "/")]: { mcpServers: { db: { command: "pg-mcp", env: { PASS: "x" } } } },
					"/elsewhere/unknown": { mcpServers: { other: { command: "o" } } },
				},
			},
		});
		const mcp = byKind(scanUser({ repos: [{ repoId: "github.com/me/repo", rootPath: root }] }), "mcp");
		expect(mcp.map((m) => [m.name, m.scope, m.repoId, m.meta.source])).toEqual([
			["db", "repo", "github.com/me/repo", "claude.json"],
		]);
	});

	it("skips MCP items when ~/.claude.json is invalid and keeps everything else", () => {
		standardUserTree(t.claude);
		writeTree(t.claude, { ".claude.json": "{ not json" });
		const items = scanUser();
		expect(byKind(items, "mcp")).toEqual([]);
		expect(byKind(items, "skill").length).toBe(4);
		expect(byKind(items, "plugin").length).toBe(2);
	});

	it("reads every user path under CLAUDE_CONFIG_DIR", () => {
		standardUserTree(t.claude);
		const items = scanUser();
		for (const i of items) expect(i.path.startsWith(t.claude)).toBe(true);
	});
});

describe("front matter is data, never code", () => {
	it("does not run ---js / ---javascript / ---coffee front matter, and records a parse error", () => {
		const g = globalThis as Record<string, unknown>;
		delete g.__ccdPwned;
		const root = repoRoot();
		writeTree(root, {
			".claude/skills/a/SKILL.md": "---js\n{ name: (globalThis.__ccdPwned = 1, 'evil') }\n---\nbody\n",
			"sub/.claude/skills/b/SKILL.md": "---javascript\n{ name: (globalThis.__ccdPwned = 2, 'evil') }\n---\n",
			"sub/.claude/skills/c/SKILL.md": "---coffee\nname: (globalThis.__ccdPwned = 3)\n---\n",
		});
		const skills = byKind(scanRepo(root, "r1"), "skill");
		expect(g.__ccdPwned).toBeUndefined();
		expect(skills.map((s) => [s.name, s.meta.parseError])).toEqual([
			["a", true],
			["b", true],
			["c", true],
		]);
	});
});

describe("SKILL.md reading is bounded", () => {
	it("reads the front matter of a huge SKILL.md and skips a SKILL.md that is not a regular file", () => {
		const root = repoRoot();
		writeTree(root, {
			".claude/skills/big/SKILL.md": `---\nname: big\ndescription: large body\n---\n${"x".repeat(5_000_000)}`,
		});
		mkdirSync(join(root, ".claude", "skills", "odd", "SKILL.md"), { recursive: true });
		const skills = byKind(scanRepo(root, "r1"), "skill");
		expect(skills.map((s) => [s.name, s.description])).toEqual([["big", "large body"]]);
	});
});

describe("scanRepo", () => {
	it("finds startup and lazy skills, skips node_modules, and reads .mcp.json", () => {
		const root = repoRoot();
		writeTree(root, {
			".claude/skills/a/SKILL.md": skillMd("a", "startup skill"),
			"sub/.claude/skills/b/SKILL.md": skillMd("b", "lazy skill"),
			"node_modules/x/.claude/skills/c/SKILL.md": skillMd("c", "ignored"),
			".mcp.json": { mcpServers: { tracker: { type: "sse", url: "https://t/sse", headers: { k: "v" } } } },
		});
		const items = scanRepo(root, "r1");
		expect(byKind(items, "skill").map((s) => [s.name, s.scope, s.repoId, s.meta.load])).toEqual([
			["a", "repo", "r1", "startup"],
			["b", "repo", "r1", "lazy"],
		]);
		expect(byKind(items, "mcp").map((m) => [m.name, m.scope, m.repoId, m.meta])).toEqual([
			["tracker", "repo", "r1", { type: "sse", url: "https://t/sse" }],
		]);
	});

	it("does not find a lazy skill deeper than 6 levels", () => {
		const root = repoRoot();
		writeTree(root, {
			"1/2/3/4/5/6/.claude/skills/six/SKILL.md": skillMd("six", null),
			"1/2/3/4/5/6/7/.claude/skills/seven/SKILL.md": skillMd("seven", null),
		});
		expect(names(byKind(scanRepo(root, "r1"), "skill"))).toEqual(["six"]);
	});

	it("terminates on a symlink loop", () => {
		const root = repoRoot();
		writeTree(root, { "sub/.claude/skills/b/SKILL.md": skillMd("b", null) });
		symlinkSync(root, join(root, "sub", "loop"), "junction");
		expect(names(byKind(scanRepo(root, "r1"), "skill"))).toEqual(["b"]);
	});

	it("reads plugins and hooks from the repo's .claude/settings.json", () => {
		const root = repoRoot();
		writeTree(root, {
			".claude/settings.json": {
				enabledPlugins: { "lint@mkt": true },
				hooks: { Stop: [{ hooks: [{ type: "command", command: "make fmt" }] }] },
			},
		});
		const items = scanRepo(root, "r1");
		expect(byKind(items, "plugin").map((p) => [p.name, p.scope, p.repoId, p.meta.enabled])).toEqual([
			["lint", "repo", "r1", true],
		]);
		expect(byKind(items, "hook").map((h) => [h.scope, h.repoId, h.meta.event, h.meta.command])).toEqual([
			["repo", "r1", "Stop", "make fmt"],
		]);
	});

	it("returns nothing for a missing root", () => {
		expect(scanRepo(join(repoRoot(), "gone"), "r1")).toEqual([]);
	});
});

describe("scan is read-only", () => {
	it("leaves the Claude tree and the repo byte-for-byte unchanged", () => {
		standardUserTree(t.claude);
		const root = repoRoot();
		writeTree(root, {
			".claude/skills/a/SKILL.md": skillMd("a", "x"),
			"sub/.claude/skills/b/SKILL.md": skillMd("b", "y"),
			".mcp.json": { mcpServers: { s: { command: "s" } } },
		});
		const before = [treeHash(t.claude), treeHash(root)];
		scanUser();
		scanRepo(root, "r1");
		expect([treeHash(t.claude), treeHash(root)]).toEqual(before);
	});
});

describe("upsertInventory", () => {
	it("inserts, then updates, and leaves an unseen item's last_seen older than the scope's last scan", () => {
		standardUserTree(t.claude);
		db = seedDb();
		const t1 = new Date("2026-10-01T10:00:00Z");
		const t2 = new Date("2026-10-02T10:00:00Z");
		const first = scanUser();
		expect(upsertInventory(db, first, "user", t1)).toEqual({ inserted: first.length, updated: 0 });
		expect(getMeta(db, "last_scan_user")).toBe(t1.toISOString());

		rmSync(join(t.claude, "skills", "code-review"), { recursive: true });
		const second = scanUser();
		expect(upsertInventory(db, second, "user", t2)).toEqual({ inserted: 0, updated: first.length - 1 });
		expect(getMeta(db, "last_scan_user")).toBe(t2.toISOString());

		const row = (name: string) =>
			db
				?.prepare("SELECT first_seen, last_seen FROM inventory WHERE name = ?")
				.get<{ first_seen: string; last_seen: string }>(name);
		expect(row("code-review")).toEqual({ first_seen: t1.toISOString(), last_seen: t1.toISOString() });
		expect(row("superpowers:brainstorming")).toEqual({ first_seen: t1.toISOString(), last_seen: t2.toISOString() });
		expect((row("code-review")?.last_seen ?? "") < (getMeta(db, "last_scan_user") ?? "")).toBe(true);
	});

	it("stores meta as JSON and keys repo items by repo_id, writing last_scan_repo:<id>", () => {
		const root = repoRoot();
		mkdirSync(root, { recursive: true });
		writeTree(root, { ".claude/skills/a/SKILL.md": skillMd("a", "startup skill") });
		db = seedDb();
		const now = new Date("2026-10-02T00:00:00Z");
		upsertInventory(db, scanRepo(root, "r1"), "repo:r1", now);
		upsertInventory(db, scanRepo(root, "r2"), "repo:r2", now);
		const rows = db
			.prepare("SELECT repo_id, scope, kind, name, description, meta FROM inventory ORDER BY repo_id")
			.all<{ repo_id: string; meta: string }>();
		expect(rows.map((r) => [r.repo_id, JSON.parse(r.meta).load])).toEqual([
			["r1", "startup"],
			["r2", "startup"],
		]);
		expect(getMeta(db, "last_scan_repo:r1")).toBe(now.toISOString());
	});
});

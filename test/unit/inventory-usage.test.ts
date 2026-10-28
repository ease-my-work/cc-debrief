import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type InventoryItem, upsertInventory } from "../../src/collector/inventory";
import type { Db } from "../../src/db/adapter";
import { getInventory } from "../../src/db/queries/inventory";
import { applyScan, deriveInventoryUsage, deriveMissingInventoryUsage } from "../../src/derive/inventory-usage";
import { deriveSession } from "../../src/derive/session";
import { seedDb, storeLines } from "../helpers/seed";
import { type TmpHome, tmpHome } from "../helpers/tmp-home";

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

const ROOT = join("/", "work", "repo");
const SID = "11111111-0000-4000-8000-000000000001";
const T = (s: string) => `2026-09-01T10:${s}.000Z`;
let n = 0;
const base = (ts: string) => ({ uuid: `x-${++n}`, timestamp: T(ts), cwd: ROOT, entrypoint: "cli" });

const prompt = (ts: string, text: string) => ({
	...base(ts),
	type: "user",
	promptId: `p-${ts}`,
	message: { role: "user", content: text },
});
const listing = (ts: string, names: string[], isInitial = true) => ({
	...base(ts),
	type: "attachment",
	attachment: { type: "skill_listing", isInitial, skillCount: names.length, names },
});
const dynamicSkill = (ts: string, names: string[], dir: string) => ({
	...base(ts),
	type: "attachment",
	attachment: { type: "dynamic_skill", skillDir: dir, skillNames: names, displayPath: "sub/.claude/skills" },
});
const invokedSkills = (ts: string, names: string[]) => ({
	...base(ts),
	type: "attachment",
	attachment: { type: "invoked_skills", skills: names.map((name) => ({ name, path: `x/${name}` })) },
});
const toolUse = (ts: string, id: string, name: string, input: object) => [
	{
		...base(ts),
		type: "assistant",
		requestId: `req-${id}`,
		message: {
			id: `msg-${id}`,
			model: "claude-opus-5-5",
			role: "assistant",
			content: [{ type: "tool_use", id, name, input }],
			usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
		},
	},
	{
		...base(ts),
		type: "user",
		message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] },
	},
];
const slash = (ts: string, name: string) => ({
	...base(ts),
	type: "user",
	message: {
		role: "user",
		content: `<command-message>${name}</command-message>\n<command-name>/${name}</command-name>`,
	},
});

const item = (over: Partial<InventoryItem> & Pick<InventoryItem, "name">): InventoryItem => ({
	scope: "user",
	repoId: null,
	kind: "skill",
	path: `/p/${over.name}`,
	description: null,
	meta: {},
	...over,
});

function seedInventory(items: InventoryItem[]) {
	upsertInventory(db, items, "user", new Date("2026-08-01T00:00:00Z"));
}

function setRepo(sessionId: string, repoId: string) {
	db.prepare("INSERT OR IGNORE INTO repos (repo_id, root_path, name) VALUES (?, ?, ?)").run(repoId, ROOT, "repo");
	// Stored test lines have no transcripts.cwd; snapshot/enrich would also set these.
	db.prepare("UPDATE sessions SET repo_id = ?, cwd = ? WHERE session_id = ?").run(repoId, ROOT, sessionId);
}

function derive(lines: object[], opts: { sessionId?: string; repoId?: string } = {}) {
	const sid = opts.sessionId ?? SID;
	storeLines(db, sid, lines);
	deriveSession(db, sid);
	if (opts.repoId) {
		setRepo(sid, opts.repoId);
		deriveInventoryUsage(db, sid);
	}
}

type UsageRow = { name: string; scope: string; repo_id: string | null; loaded: number; invoked: number };
const usage = (sessionId = SID) =>
	db
		.prepare(
			`SELECT i.name, i.scope, i.repo_id, u.loaded, u.invoked FROM inventory_usage u JOIN inventory i ON i.id = u.inventory_id
			 WHERE u.session_id = ? ORDER BY i.name, i.scope`,
		)
		.all<UsageRow>(sessionId);
const row = (name: string, sessionId = SID) => usage(sessionId).find((r) => r.name === name);

describe("deriveInventoryUsage: skills", () => {
	it("marks every listed name loaded, matching user and plugin skills by exact name", () => {
		seedInventory([
			item({ name: "code-review" }),
			item({ name: "superpowers:brainstorming", scope: "plugin", meta: { plugin: "superpowers" } }),
			item({ name: "unlisted" }),
		]);
		derive([listing("00", ["code-review", "superpowers:brainstorming"]), prompt("01", "hi")]);
		expect(usage()).toEqual([
			{ name: "code-review", scope: "user", repo_id: null, loaded: 1, invoked: 0 },
			{ name: "superpowers:brainstorming", scope: "plugin", repo_id: null, loaded: 1, invoked: 0 },
		]);
	});

	it("unions the initial listing, delta listings and dynamic_skill names", () => {
		seedInventory([item({ name: "a" }), item({ name: "b" }), item({ name: "c" })]);
		derive([
			listing("00", ["a"]),
			prompt("01", "hi"),
			listing("02", ["b"], false),
			dynamicSkill("03", ["c"], join(ROOT, "sub", ".claude", "skills")),
		]);
		expect(usage().map((r) => [r.name, r.loaded])).toEqual([
			["a", 1],
			["b", 1],
			["c", 1],
		]);
	});

	it("marks a skill invoked by a Skill call, and only that skill", () => {
		seedInventory([item({ name: "code-review" }), item({ name: "other" })]);
		derive([
			listing("00", ["code-review", "other"]),
			prompt("01", "review"),
			...toolUse("02", "t1", "Skill", { skill: "code-review" }),
		]);
		expect(usage().map((r) => [r.name, r.invoked])).toEqual([
			["code-review", 1],
			["other", 0],
		]);
	});

	it("marks a skill invoked by its slash command and ignores built-in commands", () => {
		seedInventory([
			item({ name: "caveman:caveman-help", scope: "plugin", meta: { plugin: "caveman" } }),
			item({ name: "compact" }),
		]);
		derive([
			listing("00", ["caveman:caveman-help", "compact"]),
			slash("01", "caveman:caveman-help"),
			slash("02", "compact"),
		]);
		expect(usage().map((r) => [r.name, r.invoked])).toEqual([
			["caveman:caveman-help", 1],
			["compact", 0],
		]);
	});

	it("ignores invoked_skills attachments", () => {
		seedInventory([item({ name: "hello" })]);
		derive([listing("00", ["hello"]), prompt("01", "hi"), invokedSkills("02", ["hello"])]);
		expect(row("hello")).toMatchObject({ loaded: 1, invoked: 0 });
	});

	it("creates a transcript-only row for a listed name that is not installed", () => {
		derive([listing("00", ["ghost", "plug:tool"]), prompt("01", "hi")]);
		const rows = db
			.prepare("SELECT name, scope, path, meta, first_seen, last_seen FROM inventory ORDER BY name")
			.all<{ name: string; scope: string; path: string; meta: string; first_seen: string; last_seen: string }>();
		expect(rows.map((r) => [r.name, r.scope, r.path, JSON.parse(r.meta).source, r.first_seen, r.last_seen])).toEqual([
			["ghost", "user", "", "transcript", T("00"), T("00")],
			["plug:tool", "plugin", "", "transcript", T("00"), T("00")],
		]);
		expect(row("ghost")).toMatchObject({ loaded: 1, invoked: 0 });
	});

	it("marks a transcript-only row invoked by a Skill call in the same session", () => {
		derive([listing("00", ["ghost"]), prompt("01", "hi"), ...toolUse("02", "t1", "Skill", { skill: "ghost" })]);
		expect(row("ghost")).toMatchObject({ loaded: 1, invoked: 1 });
	});

	it("gives a transcript-only row named by a dynamic_skill the repo scope", () => {
		derive([listing("00", ["demo"], false), dynamicSkill("00", ["demo"], join(ROOT, "sub", ".claude", "skills"))], {
			repoId: "r1",
		});
		expect(row("demo")).toMatchObject({ scope: "repo", repo_id: "r1", loaded: 1 });
	});

	it("marks a plugin skill invoked by its unqualified name, from a Skill call or a slash command", () => {
		seedInventory([
			item({ name: "superpowers:brainstorming", scope: "plugin", meta: { plugin: "superpowers" } }),
			item({ name: "caveman:caveman-help", scope: "plugin", meta: { plugin: "caveman" } }),
			item({ name: "caveman:other", scope: "plugin", meta: { plugin: "caveman" } }),
		]);
		derive([
			listing("00", ["superpowers:brainstorming", "caveman:caveman-help", "caveman:other"]),
			prompt("01", "go"),
			...toolUse("02", "t1", "Skill", { skill: "brainstorming" }),
			slash("03", "caveman-help"),
		]);
		expect(usage().map((r) => [r.name, r.invoked])).toEqual([
			["caveman:caveman-help", 1],
			["caveman:other", 0],
			["superpowers:brainstorming", 1],
		]);
	});

	it("marks both the user and the repo skill when they share a name", () => {
		seedInventory([item({ name: "fmt" })]);
		upsertInventory(db, [item({ name: "fmt", scope: "repo", repoId: "r1", meta: { load: "startup" } })], "repo:r1");
		derive([listing("00", ["fmt"]), prompt("01", "x"), ...toolUse("02", "t1", "Skill", { skill: "fmt" })], {
			repoId: "r1",
		});
		expect(usage().map((r) => [r.scope, r.loaded, r.invoked])).toEqual([
			["repo", 1, 1],
			["user", 1, 1],
		]);
	});
});

describe("deriveInventoryUsage: fallback without skill_listing", () => {
	it("loads user skills, enabled plugins' skills, startup repo skills and lazy skills in touched subtrees", () => {
		seedInventory([
			item({ name: "mine" }),
			item({ name: "on", scope: "plugin", kind: "plugin", meta: { enabled: true } }),
			item({ name: "off", scope: "plugin", kind: "plugin", meta: { enabled: false } }),
			item({ name: "on:s", scope: "plugin", meta: { plugin: "on" } }),
			item({ name: "off:s", scope: "plugin", meta: { plugin: "off" } }),
		]);
		const repoSkill = (name: string, dir: string, load: string) =>
			item({ name, scope: "repo", repoId: "r1", path: join(ROOT, dir, ".claude", "skills", name), meta: { load } });
		upsertInventory(
			db,
			[repoSkill("a", "", "startup"), repoSkill("b", "sub", "lazy"), repoSkill("c", join("other", "deep"), "lazy")],
			"repo:r1",
		);
		derive([prompt("00", "read it"), ...toolUse("01", "t1", "Read", { file_path: join(ROOT, "sub", "x.ts") })], {
			repoId: "r1",
		});
		expect(usage().map((r) => r.name)).toEqual(["a", "b", "mine", "on:s"]);
	});

	it("resolves a relative tool path against the session cwd", () => {
		upsertInventory(
			db,
			[
				item({
					name: "b",
					scope: "repo",
					repoId: "r1",
					path: join(ROOT, "sub", ".claude", "skills", "b"),
					meta: { load: "lazy" },
				}),
			],
			"repo:r1",
		);
		derive([prompt("00", "look"), ...toolUse("01", "t1", "Grep", { pattern: "x", path: "sub" })], { repoId: "r1" });
		expect(row("b")).toMatchObject({ loaded: 1 });
	});

	it("lets the repo's settings enable or disable a plugin for that repo's sessions", () => {
		seedInventory([
			item({ name: "foo", scope: "plugin", kind: "plugin", meta: { enabled: false } }),
			item({ name: "bar", scope: "plugin", kind: "plugin", meta: { enabled: true } }),
			item({ name: "foo:s", scope: "plugin", meta: { plugin: "foo" } }),
			item({ name: "bar:s", scope: "plugin", meta: { plugin: "bar" } }),
			item({ name: "foo", scope: "plugin", kind: "mcp", meta: { plugin: "foo" } }),
		]);
		const repoPlugin = (name: string, repoId: string, enabled: boolean) =>
			item({ name, scope: "repo", repoId, kind: "plugin", meta: { enabled } });
		upsertInventory(db, [repoPlugin("foo", "r1", true), repoPlugin("bar", "r1", false)], "repo:r1");
		upsertInventory(db, [repoPlugin("bar", "r2", true)], "repo:r2");
		derive([prompt("00", "x")], { repoId: "r1" });
		expect(usage().map((r) => [r.name, r.loaded])).toEqual([
			["foo", 1],
			["foo:s", 1],
		]);
	});

	it("loads a lazy skill whose subtree holds the session cwd", () => {
		upsertInventory(
			db,
			[
				item({
					name: "b",
					scope: "repo",
					repoId: "r1",
					path: join("/", "work", ".claude", "skills", "b"),
					meta: { load: "lazy" },
				}),
			],
			"repo:r1",
		);
		derive([prompt("00", "hi")], { repoId: "r1" });
		expect(row("b")).toMatchObject({ loaded: 1 });
	});
});

describe("deriveInventoryUsage: MCP", () => {
	const mcpCall = (ts: string, id: string, tool: string) => toolUse(ts, id, tool, { q: "x" });

	it("loads user MCP servers and marks one invoked by a call", () => {
		seedInventory([item({ name: "github", kind: "mcp" }), item({ name: "linear", kind: "mcp" })]);
		derive([prompt("00", "x"), ...mcpCall("01", "t1", "mcp__github__search_code")]);
		expect(usage().map((r) => [r.name, r.loaded, r.invoked])).toEqual([
			["github", 1, 1],
			["linear", 1, 0],
		]);
	});

	it("matches an MCP server name case-insensitively", () => {
		seedInventory([item({ name: "GitHub", kind: "mcp" })]);
		derive([prompt("00", "x"), ...mcpCall("01", "t1", "mcp__github__search_code")]);
		expect(row("GitHub")).toMatchObject({ loaded: 1, invoked: 1 });
	});

	it("leaves out another repo's MCP servers", () => {
		upsertInventory(db, [item({ name: "db", kind: "mcp", scope: "repo", repoId: "r2" })], "repo:r2");
		upsertInventory(db, [item({ name: "mine", kind: "mcp", scope: "repo", repoId: "r1" })], "repo:r1");
		derive([prompt("00", "x")], { repoId: "r1" });
		expect(usage().map((r) => r.name)).toEqual(["mine"]);
	});

	it("matches a plugin server only by its plugin source, never a claude.ai connector", () => {
		seedInventory([
			item({ name: "context7", scope: "plugin", kind: "plugin", meta: { enabled: true } }),
			item({ name: "context7", scope: "plugin", kind: "mcp", meta: { plugin: "context7" } }),
		]);
		derive([prompt("00", "x"), ...mcpCall("01", "t1", "mcp__claude_ai_Context7__query-docs")]);
		expect(row("context7")).toMatchObject({ loaded: 1, invoked: 0 });
		derive([...mcpCall("02", "t2", "mcp__plugin_context7_context7__query-docs")]);
		expect(row("context7")).toMatchObject({ loaded: 1, invoked: 1 });
	});

	it("gives plugins and hooks no rows", () => {
		seedInventory([
			item({ name: "p", scope: "plugin", kind: "plugin", meta: { enabled: true } }),
			item({ name: "Stop: x", kind: "hook" }),
		]);
		derive([listing("00", []), prompt("01", "x")]);
		expect(usage()).toEqual([]);
	});
});

describe("deriveInventoryUsage: idempotence", () => {
	it("gives identical rows on a second derive, a full rebuild and a rebuild from stored signals", () => {
		seedInventory([item({ name: "code-review" }), item({ name: "github", kind: "mcp" })]);
		derive([
			listing("00", ["code-review"]),
			prompt("01", "x"),
			...toolUse("02", "t1", "Skill", { skill: "code-review" }),
			slash("03", "code-review"),
		]);
		const first = usage();
		deriveSession(db, SID);
		expect(usage()).toEqual(first);
		deriveSession(db, SID, { full: true });
		expect(usage()).toEqual(first);
		deriveInventoryUsage(db, SID);
		expect(usage()).toEqual(first);
	});

	it("keeps the listing and slash commands of earlier lines across append derives", () => {
		seedInventory([item({ name: "a" }), item({ name: "b" })]);
		derive([listing("00", ["a"]), prompt("01", "x")]);
		derive([slash("02", "a"), prompt("03", "y"), listing("04", ["b"], false)]);
		expect(usage().map((r) => [r.name, r.loaded, r.invoked])).toEqual([
			["a", 1, 1],
			["b", 1, 0],
		]);
	});

	it("keeps a pre-Phase-2 session's earlier listing and commands when its first new lines arrive", () => {
		seedInventory([item({ name: "a" }), item({ name: "b" })]);
		derive([listing("00", ["a"]), slash("01", "a"), prompt("02", "x")]);
		db.prepare("DELETE FROM meta WHERE key LIKE 'skills:%'").run(); // derived before signals existed
		derive([prompt("03", "y"), listing("04", ["b"], false)]); // append path
		expect(usage().map((r) => [r.name, r.loaded, r.invoked])).toEqual([
			["a", 1, 1],
			["b", 1, 0],
		]);
	});

	it("rebuilds signals from stored lines when none were recorded", () => {
		seedInventory([item({ name: "a" })]);
		derive([listing("00", ["a"]), slash("01", "a")]);
		db.prepare("DELETE FROM meta WHERE key LIKE 'skills:%'").run();
		db.prepare("DELETE FROM inventory_usage").run();
		deriveInventoryUsage(db, SID);
		expect(row("a")).toMatchObject({ loaded: 1, invoked: 1 });
	});
});

describe("deriveMissingInventoryUsage", () => {
	it("derives sessions that predate Phase 2 in resumable batches, then finds none", () => {
		seedInventory([item({ name: "a" })]);
		const ids = ["11111111-0000-4000-8000-0000000000a1", "11111111-0000-4000-8000-0000000000a2"];
		for (const id of ids) derive([listing("00", ["a"]), slash("01", "a")], { sessionId: id });
		// As derived before Phase 2: no stored signals, no usage rows.
		db.prepare("DELETE FROM meta WHERE key LIKE 'skills:%'").run();
		db.prepare("DELETE FROM inventory_usage").run();
		expect(deriveMissingInventoryUsage(db, 1)).toBe(1);
		expect(deriveMissingInventoryUsage(db, 5)).toBe(1);
		expect(deriveMissingInventoryUsage(db, 5)).toBe(0);
		for (const id of ids) expect(row("a", id)).toMatchObject({ loaded: 1, invoked: 1 });
	});
});

describe("applyScan after a removal", () => {
	it("shows a removed skill as removed and keeps its usage history", () => {
		applyScan(db, [item({ name: "gone" })], "user", new Date("2026-08-01T00:00:00Z"));
		derive([listing("00", ["gone"]), ...toolUse("01", "t1", "Skill", { skill: "gone" })]);
		applyScan(db, [], "user", new Date("2026-09-02T00:00:00Z")); // the skill directory was deleted
		expect(row("gone")).toMatchObject({ loaded: 1, invoked: 1 });
		const listed = getInventory(db, { kind: "skill", range: "30d", now: new Date("2026-09-02T12:00:00Z") }).items;
		expect(listed.find((i) => i.name === "gone")).toMatchObject({ removed: true, sessionsInvoked: 1 });
	});
});

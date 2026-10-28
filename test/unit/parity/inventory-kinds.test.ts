// Phase 7 Task 13 (P11): agents, commands, output styles, rules and workflows in user, repo and plugin .claude/
// folders; usage for agents (subagent type) and commands (slash command); "usage not recorded" for the rest.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanRepo, scanUser } from "../../../src/collector/inventory";
import type { Db } from "../../../src/db/adapter";
import { getInventory } from "../../../src/db/queries/inventory";
import { deriveInventoryUsage, scanRepoInto, scanUserInto } from "../../../src/derive/inventory-usage";
import { addPlugin, writeTree } from "../../helpers/claude-tree";
import { seedDb } from "../../helpers/seed";
import { type TmpHome, tmpHome } from "../../helpers/tmp-home";

const md = (fm: Record<string, string>, body = "body") =>
	`---\n${Object.entries(fm)
		.map(([k, v]) => `${k}: ${v}`)
		.join("\n")}\n---\n\n${body}\n`;

let h: TmpHome;
beforeEach(() => {
	h = tmpHome();
});
afterEach(() => h.cleanup());

const pick = (items: ReturnType<typeof scanUser>, kind: string) =>
	items
		.filter((i) => i.kind === kind)
		.map((i) => [i.scope, i.name, i.description])
		.sort();

describe("scanning the new kinds", () => {
	it("reads user agents, commands (nested as a:b), output styles, rules and workflows", () => {
		writeTree(h.claude, {
			"agents/reviewer.md": md({ name: "code-reviewer", description: "Reviews diffs" }),
			"agents/plain.md": "no front matter",
			"commands/deploy.md": md({ description: "Deploy it" }),
			"commands/git/sync.md": md({}),
			"output-styles/terse.md": md({ name: "Terse", description: "Short answers" }),
			"rules/style/ts.md": md({ description: "TS style" }),
			"workflows/release.yml": "steps: []",
			"agents/notes.txt": "ignored",
		});
		const items = scanUser();
		expect(pick(items, "agent")).toEqual([
			["user", "code-reviewer", "Reviews diffs"],
			["user", "plain", null],
		]);
		expect(pick(items, "command")).toEqual([
			["user", "deploy", "Deploy it"],
			["user", "git:sync", null],
		]);
		expect(pick(items, "output_style")).toEqual([["user", "Terse", "Short answers"]]);
		expect(pick(items, "rule")).toEqual([["user", "style/ts", "TS style"]]);
		expect(pick(items, "workflow")).toEqual([["user", "release", null]]);
	});

	it("reads them from a repo's .claude folder and from plugins (plugin:name)", () => {
		const repo = join(h.home, "..", "repo");
		mkdirSync(repo, { recursive: true });
		writeTree(repo, {
			".claude/agents/db.md": md({ name: "db-expert" }),
			".claude/commands/test.md": md({ description: "Run tests" }),
			".claude/rules/api.md": md({}),
		});
		expect(
			scanRepo(repo, "r1")
				.filter((i) => ["agent", "command", "rule"].includes(i.kind))
				.map((i) => [i.kind, i.name, i.repoId]),
		).toEqual([
			["agent", "db-expert", "r1"],
			["command", "test", "r1"],
			["rule", "api", "r1"],
		]);
		addPlugin(h.claude, "toolkit@mkt", {
			files: { "agents/explorer.md": md({ name: "explorer" }), "commands/go.md": md({}) },
		});
		const plugin = scanUser().filter((i) => i.scope === "plugin" && ["agent", "command"].includes(i.kind));
		expect(plugin.map((i) => [i.kind, i.name, i.meta.plugin])).toEqual([
			["agent", "toolkit:explorer", "toolkit"],
			["command", "toolkit:go", "toolkit"],
		]);
	});
});

describe("command and rule names come from the path", () => {
	it("ignores a command's front matter name: Claude Code runs it as /<dir>:<file>", () => {
		writeTree(h.claude, {
			"commands/sc/implement.md": md({ name: "implement", description: "Implement" }),
			"rules/api.md": md({ name: "API rules" }),
		});
		const items = scanUser();
		expect(pick(items, "command")).toEqual([["user", "sc:implement", "Implement"]]);
		expect(pick(items, "rule")).toEqual([["user", "api", null]]);
	});
});

describe("usage of the new kinds", () => {
	let db: Db;
	beforeEach(() => {
		db = seedDb();
	});
	afterEach(() => db.close());

	it("an agent is invoked by a subagent of its type, a command by its slash command; the rest record no usage", () => {
		writeTree(h.claude, {
			"agents/reviewer.md": md({ name: "code-reviewer" }),
			"agents/unused.md": md({ name: "never" }),
			"commands/deploy.md": md({}),
			"output-styles/terse.md": md({ name: "Terse" }),
		});
		scanUserInto(db);
		db.prepare("INSERT INTO sessions (session_id, started_at) VALUES ('s1', ?)").run(new Date().toISOString());
		db.prepare("INSERT INTO subagents (session_id, agent_id, agent_type) VALUES ('s1', 'a1', 'code-reviewer')").run();
		db.prepare("INSERT INTO meta (key, value) VALUES ('skills:s1', ?)").run(
			JSON.stringify({ hasListing: false, listed: [], dynamic: [], commands: ["deploy"] }),
		);
		deriveInventoryUsage(db, "s1");
		const inv = (kind: "agent" | "command" | "output_style") =>
			getInventory(db, { kind, range: "7d", now: new Date() }).items.map((i) => [
				i.name,
				i.sessionsInvoked,
				i.status,
				i.usageRecorded,
			]);
		expect(inv("agent")).toEqual([
			["code-reviewer", 1, "active", true],
			["never", 0, "never_used", true],
		]);
		expect(inv("command")).toEqual([["deploy", 1, "active", true]]);
		expect(inv("output_style")).toEqual([["Terse", 0, "active", false]]);
	});

	it("a repo scan stores repo-level agents for that repo", () => {
		const repo = join(h.home, "..", "repo2");
		writeTree(repo, { ".claude/agents/db.md": md({ name: "db-expert" }) });
		scanRepoInto(db, repo, "r2");
		expect(db.prepare("SELECT scope, repo_id, kind, name FROM inventory WHERE kind = 'agent'").all()).toEqual([
			{ scope: "repo", repo_id: "r2", kind: "agent", name: "db-expert" },
		]);
	});
});

describe("GET /api/inventory for the new kinds", () => {
	it("accepts each kind", async () => {
		const { createApp } = await import("../../../src/server/app");
		const db = seedDb();
		try {
			const app = createApp(db, { port: 4242, uiDir: "/x" });
			for (const kind of ["agent", "command", "output_style", "rule", "workflow"]) {
				const r = await app.request(`/api/inventory?kind=${kind}`, { headers: { host: "localhost:4242" } });
				expect(r.status, kind).toBe(200);
			}
		} finally {
			db.close();
		}
	});
});

// Replays every Phase 0 transcript fixture through the real ingest and derive.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { upsertInventory } from "../../src/collector/inventory";
import { loadConfig } from "../../src/config";
import type { Db } from "../../src/db/adapter";
import { ingestPending } from "../../src/ingest/ingest";
import { copyFixtureInto, loadFixtureCases } from "../helpers/fixtures";
import { seedDb } from "../helpers/seed";
import { type TmpHome, tmpHome } from "../helpers/tmp-home";

const fixtureJsonlFilesIn = (dir: string): string[] =>
	readdirSync(dir).flatMap((name) => {
		const p = join(dir, name);
		return statSync(p).isDirectory() ? fixtureJsonlFilesIn(p) : p.endsWith(".jsonl") ? [p] : [];
	});

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

describe.each(loadFixtureCases().map((c) => [`${c.surface}/${c.caseJson.case}`, c] as const))(
	"fixture %s",
	(_name, c) => {
		it("derives without errors, with the recorded surface, title and reported cost", () => {
			copyFixtureInto(h.claude, c.caseDir);
			const r = ingestPending(db, { config: { ...loadConfig(), retention: { days: 0 } } });
			expect(r.parseErrors).toBe(0);
			expect(r.sessions).toContain(c.sessionId);
			const s = db.prepare("SELECT * FROM sessions WHERE session_id = ?").get<Record<string, unknown>>(c.sessionId);
			expect(s).toBeDefined();
			expect(s?.surface).toBe(c.surface);
			expect(s?.started_at).toEqual(expect.any(String));
			expect(s?.cwd).toEqual(expect.any(String));
			const covers = c.caseJson.covers;
			if (covers.includes("ai-title") || covers.includes("custom-title")) expect(s?.title).toEqual(expect.any(String));
			if (covers.includes("cost-state")) expect(s?.reported_cost_usd).toEqual(expect.any(Number));
			if (covers.includes("subagent")) {
				const n = db
					.prepare("SELECT count(*) AS n FROM subagents WHERE session_id = ?")
					.get<{ n: number }>(c.sessionId);
				expect(n?.n).toBeGreaterThan(0);
			}
			if (covers.includes("compaction")) {
				const n = db
					.prepare("SELECT count(*) AS n FROM compactions WHERE session_id = ?")
					.get<{ n: number }>(c.sessionId);
				expect(n?.n).toBeGreaterThan(0);
			}
			const turns = db.prepare("SELECT count(*) AS n FROM turns WHERE session_id = ?").get<{ n: number }>(c.sessionId);
			expect(turns?.n).toBeGreaterThan(0);
		});

		it("gives every tool_use exactly one tool_calls row with consistent ok / denied / exit codes", () => {
			copyFixtureInto(h.claude, c.caseDir);
			ingestPending(db, { config: { ...loadConfig(), retention: { days: 0 } } });
			const toolUseIds = new Set<string>();
			for (const f of fixtureJsonlFilesIn(c.caseDir)) {
				for (const raw of readFileSync(f, "utf8").split("\n")) {
					if (!raw.trim()) continue;
					const l = JSON.parse(raw);
					if (l.type !== "assistant" || !Array.isArray(l.message?.content)) continue;
					for (const b of l.message.content) if (b?.type === "tool_use") toolUseIds.add(b.id);
				}
			}
			const rows = db
				.prepare(
					"SELECT tool_use_id, tool_name, ok, denied, exit_code, mcp_source FROM tool_calls WHERE session_id = ?",
				)
				.all<{
					tool_use_id: string;
					tool_name: string;
					ok: number | null;
					denied: string | null;
					exit_code: number | null;
					mcp_source: string | null;
				}>(c.sessionId);
			expect(rows.map((r) => r.tool_use_id).sort()).toEqual([...toolUseIds].sort());
			expect(rows.filter((r) => r.ok === 1 && r.denied !== null)).toEqual([]);
			const covers = c.caseJson.covers;
			if (covers.includes("powershell-fail")) {
				expect(rows.some((r) => r.tool_name === "PowerShell" && r.ok === 0 && r.exit_code === 1)).toBe(true);
			}
			if (covers.includes("bash-fail")) {
				expect(rows.some((r) => r.tool_name === "Bash" && r.ok === 0 && r.exit_code === 1)).toBe(true);
			}
			if (covers.includes("denial")) expect(rows.some((r) => r.denied !== null && r.ok === 0)).toBe(true);
			if (covers.includes("mcp-plugin")) expect(rows.some((r) => r.mcp_source === "plugin:context7")).toBe(true);
			if (covers.includes("mcp-connector")) expect(rows.some((r) => r.mcp_source === "claude.ai")).toBe(true);
			if (covers.includes("edit")) {
				const n = db
					.prepare("SELECT count(*) AS n FROM file_changes WHERE session_id = ?")
					.get<{ n: number }>(c.sessionId);
				expect(n?.n).toBeGreaterThan(0);
			}
		});

		it("marks an invoked skill for every session with a Skill call", () => {
			copyFixtureInto(h.claude, c.caseDir);
			ingestPending(db, { config: { ...loadConfig(), retention: { days: 0 } } });
			const sessions = db
				.prepare("SELECT DISTINCT session_id FROM tool_calls WHERE tool_name = 'Skill'")
				.all<{ session_id: string }>()
				.map((r) => r.session_id);
			for (const sid of sessions) {
				const n = db
					.prepare("SELECT count(*) AS n FROM inventory_usage WHERE session_id = ? AND invoked = 1")
					.get<{ n: number }>(sid);
				expect(n?.n, sid).toBeGreaterThan(0);
			}
		});
	},
);

describe("windows-scenario-s inventory usage (Phase 0 A6, A7)", () => {
	const cases = loadFixtureCases().filter((c) => c.caseJson.case === "windows-scenario-s");

	it.each(cases.map((c) => [c.surface, c] as const))(
		"%s: matches installed rows and marks demo loaded",
		(surface, c) => {
			upsertInventory(
				db,
				[
					{ scope: "user", repoId: null, kind: "skill", name: "hello", path: "/s/hello", description: null, meta: {} },
					{
						scope: "plugin",
						repoId: null,
						kind: "skill",
						name: "caveman:caveman-help",
						path: "/p/caveman-help",
						description: null,
						meta: { plugin: "caveman" },
					},
				],
				"user",
			);
			copyFixtureInto(h.claude, c.caseDir);
			ingestPending(db, { config: { ...loadConfig(), retention: { days: 0 } } });
			const rows = db
				.prepare(
					`SELECT i.name, i.scope, i.path, u.loaded, u.invoked FROM inventory_usage u JOIN inventory i ON i.id = u.inventory_id
				 WHERE u.session_id = ? AND i.name IN ('hello', 'caveman:caveman-help', 'demo') ORDER BY i.name`,
				)
				.all<{ name: string; scope: string; path: string; loaded: number; invoked: number }>(c.sessionId);
			// The VS Code run never typed /caveman:caveman-help, so only CLI and desktop invoke it. VS Code writes no
			// dynamic_skill, so its transcript-only demo row is guessed user-scoped (a scan later corrects it in place).
			expect(rows).toEqual([
				{
					name: "caveman:caveman-help",
					scope: "plugin",
					path: "/p/caveman-help",
					loaded: 1,
					invoked: surface === "vscode" ? 0 : 1,
				},
				{ name: "demo", scope: surface === "vscode" ? "user" : "repo", path: "", loaded: 1, invoked: 1 },
				{ name: "hello", scope: "user", path: "/s/hello", loaded: 1, invoked: 1 },
			]);
		},
	);
});

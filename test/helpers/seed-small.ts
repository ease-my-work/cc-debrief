// A small deterministic dashboard DB (Phase 2 Task 6): six sessions across three surfaces and two repos, with a
// reported (cost-state) total, an unknown model, one in progress, one without usage and one imported.
// Times are local wall-clock times relative to SMALL_NOW (Fri 2 Oct 2026 12:00 local), so day buckets are stable in
// any time zone. Expected values live in seed-small.expected.ts.
import type { Db } from "../../src/db/adapter";
import { encodePayload } from "../../src/ingest/line";

export const SMALL_NOW = new Date(2026, 9, 2, 12, 0, 0);
/** Local time on a day of Aug-Oct 2026 as an ISO (UTC) string. */
export const at = (month: 8 | 9 | 10, day: number, h: number, m = 0, s = 0, ms = 0) =>
	new Date(2026, month - 1, day, h, m, s, ms).toISOString();

export const SONNET = "claude-sonnet-4-5";
export const OPUS = "claude-opus-4-1";
export const MYSTERY = "claude-mystery-9";

export const S = {
	s1: "11111111-0000-4000-8000-000000000001", // cli, app, counted, rich detail
	s2: "22222222-0000-4000-8000-000000000002", // vscode, api, reported total, title
	s3: "33333333-0000-4000-8000-000000000003", // desktop, app, unknown model, imported
	s4: "44444444-0000-4000-8000-000000000004", // cli, no repo, in progress
	s5: "55555555-0000-4000-8000-000000000005", // cli, app, no usage rows
	s6: "66666666-0000-4000-8000-000000000006", // vscode, api, 20 days ago (30d only)
} as const;

export const REPO_APP = "github.com/me/app";
export const REPO_API = "github.com/me/api";

type SessionRow = {
	id: string;
	surface: string;
	repo: string | null;
	start: string;
	end: string;
	capture?: "hooks" | "backfill";
	title?: string;
	models: string[];
	reported?: { cost: number; usage: Record<string, object> };
	ended?: boolean; // SessionEnd event
};

export function seedSmall(db: Db): void {
	db.transaction(() => {
		const repo = db.prepare("INSERT INTO repos (repo_id, root_path, remote_url, name) VALUES (?, ?, ?, ?)");
		repo.run(REPO_APP, "/w/app", "https://github.com/me/app.git", "app");
		repo.run(REPO_API, "/w/api", null, "api");

		const sessions: SessionRow[] = [
			{ id: S.s1, surface: "cli", repo: REPO_APP, start: at(10, 1, 10), end: at(10, 1, 10, 30), models: [SONNET] },
			{
				id: S.s2,
				surface: "vscode",
				repo: REPO_API,
				start: at(9, 30, 15),
				end: at(9, 30, 16),
				title: "Add login page",
				models: [OPUS],
				reported: {
					cost: 1.5,
					usage: { [OPUS]: { input: 300, output: 200, cacheRead: 2400, cacheCreation: 100, costUsd: 1.5 } },
				},
			},
			{
				id: S.s3,
				surface: "desktop",
				repo: REPO_APP,
				start: at(9, 29, 9),
				end: at(9, 29, 9, 20),
				capture: "backfill",
				models: [MYSTERY],
			},
			{
				id: S.s4,
				surface: "cli",
				repo: null,
				start: at(10, 2, 11, 20),
				end: at(10, 2, 11, 55),
				models: [SONNET],
				ended: false,
			},
			{ id: S.s5, surface: "cli", repo: REPO_APP, start: at(9, 28, 14), end: at(9, 28, 14, 10), models: [] },
			{ id: S.s6, surface: "vscode", repo: REPO_API, start: at(9, 12, 10), end: at(9, 12, 11), models: [SONNET] },
		];
		const ins = db.prepare(
			`INSERT INTO sessions (session_id, started_at, ended_at, cwd, repo_id, branch, surface, capture, start_reason,
			   permission_mode, models, title, reported_cost_usd, reported_usage)
			 VALUES (?, ?, ?, ?, ?, 'main', ?, ?, 'startup', 'default', ?, ?, ?, ?)`,
		);
		const event = db.prepare("INSERT INTO events (session_id, event, ts, payload) VALUES (?, ?, ?, '{}')");
		for (const s of sessions) {
			ins.run(
				s.id,
				s.start,
				s.end,
				s.repo === REPO_API ? "/w/api" : "/w/app",
				s.repo,
				s.surface,
				s.capture ?? "hooks",
				JSON.stringify(s.models),
				s.title ?? null,
				s.reported?.cost ?? null,
				s.reported ? JSON.stringify(s.reported.usage) : null,
			);
			if ((s.capture ?? "hooks") === "hooks") event.run(s.id, "SessionStart", s.start);
			if (s.ended !== false) event.run(s.id, "SessionEnd", s.end);
		}

		const usage = db.prepare(
			`INSERT INTO usage (session_id, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
			   cost_usd, ts, message_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		let msg = 0;
		const u = (
			sid: string,
			model: string,
			i: number,
			o: number,
			cw: number,
			cr: number,
			cost: number | null,
			ts: string,
		) => usage.run(sid, model, i, o, cw, cr, cost, ts, `msg-${++msg}`);
		u(S.s1, SONNET, 100, 50, 200, 650, 0.1, at(10, 1, 10, 5));
		u(S.s1, SONNET, 100, 50, 0, 850, 0.05, at(10, 1, 10, 20));
		u(S.s2, OPUS, 200, 100, 100, 1600, 1.0, at(9, 30, 15, 30));
		u(S.s3, MYSTERY, 50, 50, 0, 0, null, at(9, 29, 9, 10));
		u(S.s4, SONNET, 10, 10, 0, 80, 0.01, at(10, 2, 11, 50));
		u(S.s6, SONNET, 1000, 0, 0, 0, 0.5, at(9, 12, 10, 30));

		// S1 turns, tool calls, subagent, compaction, files, instructions.
		const turn = db.prepare(
			"INSERT INTO turns (session_id, seq, user_text, assistant_text, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?)",
		);
		const t1 = Number(
			turn.run(S.s1, 1, "Please fix the alembic migration", "a".repeat(400), at(10, 1, 10), at(10, 1, 10, 9))
				.lastInsertRowid,
		);
		const t2 = Number(turn.run(S.s1, 2, "Run it again", "Done.", at(10, 1, 10, 15), at(10, 1, 10, 30)).lastInsertRowid);
		turn.run(S.s2, 1, "Add a login page with 50% less code", null, at(9, 30, 15), at(9, 30, 16));
		turn.run(S.s3, 1, "Explain the scheduler\nsecond line", null, at(9, 29, 9), at(9, 29, 9, 20));
		turn.run(S.s4, 1, "Still working on it", null, at(10, 2, 11, 20), null);
		turn.run(S.s5, 1, "Quick question", null, at(9, 28, 14), at(9, 28, 14, 10));
		turn.run(S.s6, 1, "Old work", null, at(9, 12, 10), at(9, 12, 11));

		const call = db.prepare(
			`INSERT INTO tool_calls (session_id, agent_id, turn_id, tool_use_id, tool_name, mcp_server, mcp_source, mcp_tool,
			   skill_name, input, started_at, ended_at, ok, denied, exit_code)
			 VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		const c = (
			turnId: number,
			id: string,
			name: string,
			input: object,
			start: string,
			end: string,
			ok: number,
			extra: { agent?: string; mcp?: [string, string]; skill?: string; denied?: string; exit?: number } = {},
		) =>
			call.run(
				S.s1,
				extra.agent ?? null,
				turnId,
				id,
				name,
				extra.mcp?.[0] ?? null,
				extra.mcp?.[1] ?? null,
				extra.skill ?? null,
				encodePayload(input),
				start,
				end,
				ok,
				extra.denied ?? null,
				extra.exit ?? null,
			);
		c(t1, "tu-1", "Bash", { command: "npm test" }, at(10, 1, 10, 1), at(10, 1, 10, 1, 2), 0, { exit: 1 });
		c(t1, "tu-2", "Bash", { command: "npm test -- --run" }, at(10, 1, 10, 2), at(10, 1, 10, 2, 1), 1);
		c(t1, "tu-3", "Grep", { pattern: "x" }, at(10, 1, 10, 3), at(10, 1, 10, 3, 0, 500), 1);
		c(t1, "tu-4", "mcp__github__search_code", { q: "x" }, at(10, 1, 10, 4), at(10, 1, 10, 4, 1, 800), 1, {
			mcp: ["github", "search_code"],
		});
		c(t1, "tu-agent", "Agent", { subagent_type: "Explore" }, at(10, 1, 10, 5), at(10, 1, 10, 6), 1);
		c(t1, "tu-s1", "Read", { file_path: "/w/app/a.ts" }, at(10, 1, 10, 5, 10), at(10, 1, 10, 5, 11), 1, {
			agent: "ag1",
		});
		c(t1, "tu-s2", "Grep", { pattern: "y" }, at(10, 1, 10, 5, 20), at(10, 1, 10, 5, 21), 1, { agent: "ag1" });
		c(t1, "tu-5", "Skill", { skill: "code-review" }, at(10, 1, 10, 7), at(10, 1, 10, 7, 0, 100), 1, {
			skill: "code-review",
		});
		c(t2, "tu-6", "Write", { file_path: "/w/app/c.ts" }, at(10, 1, 10, 16), at(10, 1, 10, 16, 5), 0, {
			denied: "user",
		});

		db.prepare(
			`INSERT INTO subagents (session_id, agent_id, agent_type, description, tool_use_id, started_at, ended_at)
			 VALUES (?, 'ag1', 'Explore', 'find tests', 'tu-agent', ?, ?)`,
		).run(S.s1, at(10, 1, 10, 5), at(10, 1, 10, 6));
		db.prepare(
			"INSERT INTO compactions (session_id, ts, trigger, pre_tokens, post_tokens) VALUES (?, ?, 'manual', 9000, 2000)",
		).run(S.s1, at(10, 1, 10, 10));
		const fc = db.prepare(
			"INSERT INTO file_changes (session_id, repo_id, path, lines_added, lines_removed, language) VALUES (?, ?, ?, ?, ?, ?)",
		);
		fc.run(S.s1, REPO_APP, "src/a.ts", 6, 2, "typescript");
		fc.run(S.s1, REPO_APP, "src/a.ts", 4, 0, "typescript");
		fc.run(S.s1, REPO_APP, "src/b.ts", 5, 0, "typescript");
		fc.run(S.s1, REPO_APP, "README.md", 3, 1, "markdown");
		fc.run(S.s2, REPO_API, "web/login.tsx", 40, 0, "typescript");
		fc.run(S.s6, REPO_API, "x.ts", 100, 0, "typescript");
		const il = db.prepare(
			"INSERT INTO instructions_loaded (session_id, file_path, kind, ts) VALUES (?, ?, 'Project', ?)",
		);
		il.run(S.s1, "/w/app/CLAUDE.md", at(10, 1, 10));
		il.run(S.s1, "/w/app/CLAUDE.md", at(10, 1, 10, 11));
	});
}

export const S7 = "77777777-0000-4000-8000-000000000007"; // cli, app, 40 days ago: the only old-helper invocation

/**
 * Inventory on top of seedSmall() (Task 7). Descriptions are sized so ctx tokens are exact: code-review 10,
 * old-helper 2, superpowers:brainstorming 20, demo 3, deploy 4, apihelp 3.
 */
export function seedSmallInventory(db: Db): void {
	db.transaction(() => {
		db.prepare(
			`INSERT INTO sessions (session_id, started_at, ended_at, cwd, repo_id, branch, surface, capture, models)
			 VALUES (?, ?, ?, '/w/app', ?, 'main', 'cli', 'hooks', '[]')`,
		).run(S7, at(8, 23, 10), at(8, 23, 11), REPO_APP);
		db.prepare("UPDATE sessions SET branch = 'feature/x' WHERE session_id = ?").run(S.s6);
		db.prepare("INSERT INTO events (session_id, event, ts, payload) VALUES (?, 'SessionEnd', ?, '{}')").run(
			S7,
			at(8, 23, 11),
		);

		const scanned = at(10, 2, 9);
		const old = at(9, 1, 9);
		const inv = db.prepare(
			`INSERT INTO inventory (scope, repo_id, kind, name, path, description, first_seen, last_seen, meta)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		const ids: Record<string, number> = {};
		const add = (
			key: string,
			scope: string,
			repo: string | null,
			kind: string,
			name: string,
			desc: string | null,
			meta: object = {},
			lastSeen = scanned,
		) => {
			ids[key] = Number(
				inv.run(scope, repo, kind, name, `/p/${name}`, desc, old, lastSeen, JSON.stringify(meta)).lastInsertRowid,
			);
		};
		add("code-review", "user", null, "skill", "code-review", "c".repeat(40));
		add("old-helper", "user", null, "skill", "old-helper", "o".repeat(8));
		add("brainstorming", "plugin", null, "skill", "superpowers:brainstorming", "b".repeat(80), {
			plugin: "superpowers",
		});
		add("demo", "repo", REPO_APP, "skill", "demo", "d".repeat(12), { load: "lazy" });
		add("deploy", "repo", REPO_APP, "skill", "deploy", "e".repeat(16), { load: "startup" });
		add("apihelp", "repo", REPO_API, "skill", "apihelp", "a".repeat(12), { load: "startup" });
		add("gone", "user", null, "skill", "gone", "g".repeat(4), {}, old); // removed: not seen by the last scan
		add("superpowers", "plugin", null, "plugin", "superpowers", null, { enabled: true, key: "superpowers@mkt" });
		add("oldtool", "plugin", null, "plugin", "oldtool", null, { enabled: false, key: "oldtool@mkt" });
		add("hook", "user", null, "hook", "Stop: echo hi", null, { event: "Stop", command: "echo hi" });
		add("github", "user", null, "mcp", "github", null, { type: "stdio", command: "gh-mcp" });
		add("tracker", "repo", REPO_APP, "mcp", "tracker", null, { type: "stdio", command: "t" });
		db.prepare("INSERT INTO meta (key, value) VALUES ('last_scan_user', ?), (?, ?), (?, ?)").run(
			scanned,
			`last_scan_repo:${REPO_APP}`,
			scanned,
			`last_scan_repo:${REPO_API}`,
			scanned,
		);

		const use = db.prepare(
			"INSERT INTO inventory_usage (inventory_id, session_id, loaded, invoked) VALUES (?, ?, 1, ?)",
		);
		const loaded: [string, string, number][] = [
			["code-review", S.s1, 1],
			["code-review", S.s2, 0],
			["code-review", S.s3, 0],
			["code-review", S.s5, 0],
			["old-helper", S.s1, 0],
			["old-helper", S.s2, 0],
			["old-helper", S7, 1],
			["brainstorming", S.s1, 0],
			["brainstorming", S.s2, 0],
			["brainstorming", S.s3, 0],
			["demo", S.s1, 0],
			["deploy", S.s1, 0],
			["deploy", S.s3, 1],
			["deploy", S.s5, 0],
			["apihelp", S.s2, 0],
			["github", S.s1, 1],
			["github", S.s2, 0],
			["tracker", S.s1, 0],
		];
		for (const [key, sid, invoked] of loaded) use.run(ids[key], sid, invoked);

		// A claude.ai connector call (no inventory row) and a third Grep for an odd-count median.
		const call = db.prepare(
			`INSERT INTO tool_calls (session_id, tool_use_id, tool_name, mcp_server, mcp_source, mcp_tool, started_at, ended_at, ok)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
		);
		call.run(
			S.s2,
			"tu-n",
			"mcp__claude_ai_Notion__search",
			"Notion",
			"claude.ai",
			"search",
			at(9, 30, 15, 10),
			at(9, 30, 15, 10, 3),
		);
		call.run(S.s2, "tu-g", "Grep", null, null, null, at(9, 30, 15, 20), at(9, 30, 15, 20, 2));
	});
}

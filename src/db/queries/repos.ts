import { type RepoInfo, repoIdFor } from "../../collector/git";
import type { Range, RepoDetail, RepoRow } from "../../server/types";
import type { Db } from "../adapter";
import { localDate, rangeStart } from "./range";
import { money, totalsFor } from "./totals";

/** Inserts or refreshes the repos row for a git work tree; returns its repo_id. */
export function upsertRepo(db: Db, info: RepoInfo): string {
	const repoId = repoIdFor(info);
	db.prepare(
		`INSERT INTO repos (repo_id, root_path, remote_url, name) VALUES (?, ?, ?, ?)
		 ON CONFLICT (repo_id) DO UPDATE SET root_path = excluded.root_path, remote_url = excluded.remote_url,
		   name = excluded.name`,
	).run(repoId, info.root, info.remoteUrl, info.name);
	return repoId;
}

// ---- GET /api/repos, GET /api/repos/:id (feature 12) ----

type RepoBase = { repo_id: string; name: string; remote_url: string | null; root_path: string };

/** Rows from ~/.claude.json are refreshed by the user scan; every other repo row by the repo's own scan. */
const PRESENT = "last_seen >= CASE WHEN json_extract(meta, '$.source') = 'claude.json' THEN ? ELSE ? END";
const lastScanUser = (db: Db): string =>
	db.prepare("SELECT value FROM meta WHERE key = 'last_scan_user'").get<{ value: string }>()?.value ?? "";

function lastScanRepo(db: Db, repoId: string): string {
	return (
		db.prepare("SELECT value FROM meta WHERE key = ?").get<{ value: string }>(`last_scan_repo:${repoId}`)?.value ?? ""
	);
}

/** One RepoRow over the repo's sessions in scope. */
function repoRow(db: Db, repo: RepoBase, range: Range, now: Date): RepoRow {
	const ids = {
		sql: "SELECT session_id FROM sessions WHERE started_at >= ? AND repo_id = ?",
		params: [rangeStart(range, now), repo.repo_id],
	};
	const sessions = db
		.prepare(`SELECT branch FROM sessions WHERE session_id IN (${ids.sql}) ORDER BY started_at DESC`)
		.all<{ branch: string | null }>(...ids.params);
	const totals = [...totalsFor(db, ids.sql, ids.params).values()];
	const lines = db
		.prepare(
			`SELECT coalesce(sum(lines_added), 0) AS a, coalesce(sum(lines_removed), 0) AS r FROM file_changes
			 WHERE repo_id = ? AND session_id IN (${ids.sql})`,
		)
		.get<{ a: number; r: number }>(repo.repo_id, ...ids.params);
	const scanned = lastScanRepo(db, repo.repo_id);
	const present = db
		.prepare(
			`SELECT id, kind, name FROM inventory WHERE scope = 'repo' AND repo_id = ? AND kind IN ('skill', 'mcp') AND ${PRESENT}`,
		)
		.all<{ id: number; kind: string; name: string }>(repo.repo_id, lastScanUser(db), scanned);
	const skillIds = present.filter((i) => i.kind === "skill").map((i) => i.id);
	const used =
		skillIds.length === 0
			? 0
			: (db
					.prepare(
						`SELECT count(DISTINCT inventory_id) AS n FROM inventory_usage
						 WHERE invoked = 1 AND inventory_id IN (${skillIds.map(() => "?").join(", ")}) AND session_id IN (${ids.sql})`,
					)
					.get<{ n: number }>(...skillIds, ...ids.params)?.n ?? 0);
	const branches = sessions.map((s) => s.branch).filter((b): b is string => b !== null);
	return {
		id: repo.repo_id,
		name: repo.name,
		remoteUrl: repo.remote_url,
		branch: branches[0] ?? null,
		branchesSeen: new Set(branches).size,
		sessions: sessions.length,
		tokens: totals.reduce((n, t) => n + t.tokens, 0),
		costUsd: money(totals.reduce((n, t) => n + (t.costUsd ?? 0), 0)),
		linesAdded: lines?.a ?? 0,
		linesRemoved: lines?.r ?? 0,
		repoSkillsUsed: used,
		repoSkillsAvailable: skillIds.length,
		repoMcp: present
			.filter((i) => i.kind === "mcp")
			.map((i) => i.name)
			.sort((a, b) => a.localeCompare(b)),
	};
}

/** Repos with at least one session in the range, most sessions first. Sessions without a repo are not listed. */
export function listRepos(db: Db, q: { range: Range; now: Date }): RepoRow[] {
	return db
		.prepare(
			`SELECT DISTINCT r.repo_id, r.name, r.remote_url, r.root_path FROM repos r
			 JOIN sessions s ON s.repo_id = r.repo_id WHERE s.started_at >= ?`,
		)
		.all<RepoBase>(rangeStart(q.range, q.now))
		.map((r) => repoRow(db, r, q.range, q.now))
		.sort((a, b) => b.sessions - a.sessions || a.name.localeCompare(b.name));
}

const normPath = (p: string) => {
	const s = p.replaceAll("\\", "/").replace(/\/+$/, "");
	return process.platform === "win32" ? s.toLowerCase() : s;
};

export function getRepoDetail(db: Db, repoId: string, q: { range: Range; now: Date }): RepoDetail | null {
	const repo = db
		.prepare("SELECT repo_id, name, remote_url, root_path FROM repos WHERE repo_id = ?")
		.get<RepoBase>(repoId);
	if (!repo) return null;
	const ids = {
		sql: "SELECT session_id FROM sessions WHERE started_at >= ? AND repo_id = ?",
		params: [rangeStart(q.range, q.now), repoId],
	};

	const files = db
		.prepare(
			`SELECT path, count(DISTINCT session_id) AS sessions, sum(lines_added) AS added, sum(lines_removed) AS removed
			 FROM file_changes WHERE repo_id = ? AND session_id IN (${ids.sql})
			 GROUP BY path ORDER BY sessions DESC, sum(lines_added) + sum(lines_removed) DESC, path LIMIT 5`,
		)
		.all<{ path: string; sessions: number; added: number; removed: number }>(repoId, ...ids.params);

	const scanned = lastScanRepo(db, repoId);
	const inv = db
		.prepare(
			`SELECT i.id, i.kind, i.name, i.meta,
			   (SELECT count(*) FROM inventory_usage u WHERE u.inventory_id = i.id AND u.loaded = 1 AND u.session_id IN (${ids.sql})) AS loaded,
			   (SELECT count(*) FROM inventory_usage u WHERE u.inventory_id = i.id AND u.invoked = 1 AND u.session_id IN (${ids.sql})) AS invoked
			 FROM inventory i WHERE i.scope = 'repo' AND i.repo_id = ? AND i.kind IN ('skill', 'mcp') AND ${PRESENT}`,
		)
		.all<{ id: number; kind: string; name: string; meta: string; loaded: number; invoked: number }>(
			...ids.params,
			...ids.params,
			repoId,
			lastScanUser(db),
			scanned,
		);
	const meta = (m: string): Record<string, unknown> => {
		try {
			return JSON.parse(m);
		} catch {
			return {};
		}
	};
	const mcpCalls = (server: string) =>
		db
			.prepare(
				`SELECT count(*) AS calls, count(DISTINCT mcp_tool) AS tools
				 FROM tool_calls WHERE lower(mcp_server) = lower(?) AND mcp_source IS NULL AND session_id IN (${ids.sql})`,
			)
			.get<{ calls: number; tools: number }>(server, ...ids.params) ?? { calls: 0, tools: 0 };

	const skills = inv
		.filter((i) => i.kind === "skill")
		.sort((a, b) => b.loaded - a.loaded || a.name.localeCompare(b.name))
		.map((i) => ({
			kind: "skill" as const,
			name: i.name,
			source: `${repo.name}/.claude/skills`,
			lazy: meta(i.meta).load === "lazy",
			invoked: i.invoked,
			loaded: i.loaded,
			used: i.invoked > 0,
		}));
	const mcp = inv
		.filter((i) => i.kind === "mcp")
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((i) => {
			const c = mcpCalls(i.name);
			return {
				kind: "mcp" as const,
				name: i.name,
				source: meta(i.meta).source === "claude.json" ? `${repo.name} (~/.claude.json)` : `${repo.name}/.mcp.json`,
				lazy: false,
				tools: c.tools,
				calls: c.calls,
				used: c.calls > 0,
			};
		});
	// Instruction files under the repo root that this repo's sessions loaded (CLAUDE.md "loaded N×").
	const root = normPath(repo.root_path);
	const loads = new Map<string, number>();
	for (const r of db
		.prepare(`SELECT file_path FROM instructions_loaded WHERE session_id IN (${ids.sql})`)
		.all<{ file_path: string }>(...ids.params)) {
		const p = normPath(r.file_path);
		if (!p.startsWith(`${root}/`)) continue;
		const rel = r.file_path.replaceAll("\\", "/").slice(root.length + 1);
		loads.set(rel, (loads.get(rel) ?? 0) + 1);
	}
	const instructions = [...loads.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.map(([name, n]) => ({
			kind: "instructions" as const,
			name,
			source: repo.name,
			lazy: false,
			loaded: n,
			used: true,
		}));

	return {
		repo: repoRow(db, repo, q.range, q.now),
		files,
		typeMix: [], // Phase 3 (session types)
		items: [...skills, ...mcp, ...instructions],
		suggestions: [], // Phase 5b
		...repoTrends(db, repoId, ids, q),
	};
}

const TOP_TOOLS = 8;

/** Local Monday (YYYY-MM-DD) of the week holding `d`. */
function mondayOf(d: Date): string {
	const back = (d.getDay() + 6) % 7;
	return localDate(new Date(d.getFullYear(), d.getMonth(), d.getDate() - back));
}

/** Phase 7 P9: languages, branches, what was used, top tools and the weekly trend of the repo's sessions in range. */
function repoTrends(
	db: Db,
	repoId: string,
	ids: { sql: string; params: unknown[] },
	q: { range: Range; now: Date },
): Pick<RepoDetail, "languages" | "branches" | "used" | "topTools" | "perWeek"> {
	const languages = db
		.prepare(
			`SELECT language, sum(lines_added) + sum(lines_removed) AS lines FROM file_changes
			 WHERE repo_id = ? AND language IS NOT NULL AND session_id IN (${ids.sql})
			 GROUP BY language ORDER BY lines DESC, language`,
		)
		.all<{ language: string; lines: number }>(repoId, ...ids.params);
	const branches = db
		.prepare(
			`SELECT branch AS name, count(*) AS sessions FROM sessions
			 WHERE branch IS NOT NULL AND session_id IN (${ids.sql}) GROUP BY branch ORDER BY sessions DESC, branch`,
		)
		.all<{ name: string; sessions: number }>(...ids.params);
	const counted = (sql: string) => db.prepare(sql).all<{ name: string; count: number }>(...ids.params);
	const used = {
		skills: counted(
			`SELECT skill_name AS name, count(*) AS count FROM tool_calls WHERE skill_name IS NOT NULL
			 AND session_id IN (${ids.sql}) GROUP BY skill_name ORDER BY count DESC, name`,
		),
		mcpServers: counted(
			`SELECT mcp_server AS name, count(*) AS count FROM tool_calls WHERE mcp_server IS NOT NULL
			 AND session_id IN (${ids.sql}) GROUP BY mcp_server ORDER BY count DESC, name`,
		),
		agentTypes: counted(
			`SELECT agent_type AS name, count(*) AS count FROM subagents WHERE agent_type IS NOT NULL
			 AND session_id IN (${ids.sql}) GROUP BY agent_type ORDER BY count DESC, name`,
		),
	};
	const topTools = db
		.prepare(
			`SELECT tool_name AS name, count(*) AS calls FROM tool_calls WHERE mcp_server IS NULL
			 AND session_id IN (${ids.sql}) GROUP BY tool_name ORDER BY calls DESC, name LIMIT ${TOP_TOOLS}`,
		)
		.all<{ name: string; calls: number }>(...ids.params);

	// Weeks from the range start (all: the repo's first session) to now, each with its sessions and their cost.
	const totals = totalsFor(db, ids.sql, ids.params);
	const starts = db
		.prepare(`SELECT session_id, started_at FROM sessions WHERE session_id IN (${ids.sql}) ORDER BY started_at`)
		.all<{ session_id: string; started_at: string }>(...ids.params);
	const from = q.range === "all" ? (starts[0]?.started_at ?? q.now.toISOString()) : rangeStart(q.range, q.now);
	const weeks = new Map<string, { week: string; sessions: number; usd: number }>();
	// Step by calendar Mondays: 7 × 24 h can jump a week across a DST change.
	const last = mondayOf(q.now);
	const start = new Date(from);
	const monday = new Date(start.getFullYear(), start.getMonth(), start.getDate() - ((start.getDay() + 6) % 7));
	for (let i = 0; ; i++) {
		const week = localDate(new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 7 * i));
		if (week > last) break;
		weeks.set(week, { week, sessions: 0, usd: 0 });
	}
	for (const s of starts) {
		const w = weeks.get(mondayOf(new Date(s.started_at)));
		if (!w) continue;
		w.sessions++;
		w.usd += totals.get(s.session_id)?.costUsd ?? 0;
	}
	const perWeek = [...weeks.values()]
		.sort((a, b) => a.week.localeCompare(b.week))
		.map((w) => ({ ...w, usd: money(w.usd) }));
	return { languages, branches, used, topTools, perWeek };
}

// GET /api/overview (feature 12). Tiles sum session totals (feature 02); the per-day chart buckets usage rows by
// local day and puts each reported session's unattributed usage on its last-activity day, so columns sum to the tile.
import { modelLabel } from "../../collector/prices";
import type { Config } from "../../config";
import type { Overview, Range, Surface } from "../../server/types";
import type { Db } from "../adapter";
import { getBudget } from "./budget";
import { dayBuckets, localDate, rangeDays, rangeStart } from "./range";
import { listSessions } from "./sessions";
import { money, totalsFor, type UsageBucket } from "./totals";

export { rangeStart } from "./range";

const RECENT = 5;
/** Repos named in the sessions-by-repo donut (Phase 7 P13); the rest are "other". */
const DONUT_REPOS = 6;

/** Sessions per repo, most first: the top DONUT_REPOS slices, then "other"; sessions outside a repo are "no repo". */
function sessionsByRepo(
	db: Db,
	repoIds: (string | null)[],
): { repoId: string | null; name: string; sessions: number }[] {
	const counts = new Map<string | null, number>();
	for (const id of repoIds) counts.set(id, (counts.get(id) ?? 0) + 1);
	const names = new Map(
		db
			.prepare("SELECT repo_id, name FROM repos")
			.all<{ repo_id: string; name: string }>()
			.map((r) => [r.repo_id, r.name]),
	);
	const rows = [...counts.entries()]
		.map(([repoId, sessions]) => ({
			repoId,
			name: repoId === null ? "no repo" : (names.get(repoId) ?? repoId),
			sessions,
		}))
		.sort((a, b) => b.sessions - a.sessions || a.name.localeCompare(b.name));
	if (rows.length <= DONUT_REPOS + 1) return rows;
	const rest = rows.slice(DONUT_REPOS).reduce((n, r) => n + r.sessions, 0);
	return [...rows.slice(0, DONUT_REPOS), { repoId: null, name: "other", sessions: rest }];
}

/** `cfg` gives the budget band (Phase 7 P4); without it `budget` is null. */
export function getOverview(db: Db, opts: { range: Range; repo?: string; now: Date; cfg?: Config }): Overview {
	const idsSql = `SELECT session_id FROM sessions WHERE started_at >= ?${opts.repo ? " AND repo_id = ?" : ""}`;
	const params: unknown[] = [rangeStart(opts.range, opts.now), ...(opts.repo ? [opts.repo] : [])];

	const sessions = db
		.prepare(`SELECT session_id, surface, ended_at, started_at, repo_id FROM sessions WHERE session_id IN (${idsSql})`)
		.all<{ session_id: string; surface: string; ended_at: string | null; started_at: string; repo_id: string | null }>(
			...params,
		);
	const buckets: UsageBucket[] = [];
	const totals = totalsFor(db, idsSql, params, { onBucket: (b) => buckets.push(b) });

	const bySurface: Record<Surface, number> = { cli: 0, vscode: 0, desktop: 0, unknown: 0 };
	for (const s of sessions) {
		const k = (s.surface in bySurface ? s.surface : "unknown") as Surface;
		bySurface[k]++;
	}

	let tokens = 0;
	let input = 0;
	let cacheWrite = 0;
	let cacheRead = 0;
	let usd = 0;
	let unknownModelTokens = 0;
	const byLabel = new Map<string, { usd: number; models: Map<string, number> }>();
	for (const t of totals.values()) {
		tokens += t.tokens;
		input += t.input;
		cacheWrite += t.cacheWrite;
		cacheRead += t.cacheRead;
		usd += t.costUsd ?? 0;
		unknownModelTokens += t.unknownTokens;
		for (const m of t.byModel) {
			if (m.costUsd === null) continue;
			const label = modelLabel(m.model);
			const entry = byLabel.get(label) ?? { usd: 0, models: new Map<string, number>() };
			entry.usd += m.costUsd;
			entry.models.set(m.model, (entry.models.get(m.model) ?? 0) + m.costUsd);
			byLabel.set(label, entry);
		}
	}
	const served = input + cacheWrite + cacheRead;

	// With a repo filter, only that repo's files count (a session can also edit files of another repo), as in Repos.
	const lines = db
		.prepare(
			`SELECT coalesce(sum(lines_added), 0) AS added, coalesce(sum(lines_removed), 0) AS removed,
			   count(DISTINCT coalesce(repo_id, '') || char(0) || path) AS files, count(DISTINCT repo_id) AS repos
			 FROM file_changes WHERE session_id IN (${idsSql})${opts.repo ? " AND repo_id = ?" : ""}`,
		)
		.get<{ added: number; removed: number; files: number; repos: number }>(
			...params,
			...(opts.repo ? [opts.repo] : []),
		) ?? {
		added: 0,
		removed: 0,
		files: 0,
		repos: 0,
	};

	// Per-day chart: 10-minute UTC buckets (exact for every whole- and half-hour zone), then local days.
	const days = rangeDays(opts.range, opts.now, db);
	// all, cut to 366 days (Phase 7): older days are left off the chart (and the note says so), not piled onto day one.
	const cut = opts.range === "all" && dayBuckets(null, opts.now, db).truncated;
	const perDay = new Map(days.map((d) => [d, { date: d, input: 0, cacheRead: 0, output: 0 }]));
	const add = (iso: string, inp: number, cr: number, out: number) => {
		const day = localDate(new Date(iso));
		if (cut && day < days[0]) return;
		const target = perDay.get(day) ?? perDay.get(day < days[0] ? days[0] : (days.at(-1) as string));
		if (!target) return;
		target.input += inp;
		target.cacheRead += cr;
		target.output += out;
	};
	// Buckets come from the same usage pass as the totals; summed per bucket first, so each converts to a day once.
	const lastActivity = new Map(sessions.map((x) => [x.session_id, x.ended_at ?? x.started_at]));
	const byBucket = new Map<string, { input: number; cacheRead: number; output: number }>();
	for (const b of buckets) {
		const key = b.bucket ?? (lastActivity.get(b.sessionId) ?? "").slice(0, 15);
		const e = byBucket.get(key) ?? { input: 0, cacheRead: 0, output: 0 };
		e.input += b.input;
		e.cacheRead += b.cacheRead;
		e.output += b.output;
		byBucket.set(key, e);
	}
	for (const [key, e] of byBucket) if (key) add(`${key}0:00.000Z`, e.input, e.cacheRead, e.output);
	// Reported sessions: the unattributed rest (reported − counted) on the last-activity day.
	for (const s of sessions) {
		const t = totals.get(s.session_id);
		if (!t || t.partial) continue;
		const u = t.unattributed;
		if (u.input + u.cacheWrite + u.cacheRead + u.output > 0) {
			add(s.ended_at ?? s.started_at, u.input + u.cacheWrite, u.cacheRead, u.output);
		}
	}

	return {
		tiles: {
			sessions: {
				total: sessions.length,
				bySurface,
				byRepo: sessionsByRepo(
					db,
					sessions.map((s) => s.repo_id),
				),
			},
			tokens: { total: tokens, cacheServedPct: served > 0 ? Math.round((cacheRead / served) * 100) : 0 },
			cost: {
				usd: money(usd),
				byModel: [...byLabel.entries()]
					.map(([label, e]) => ({
						model: [...e.models.entries()].sort((a, b) => b[1] - a[1])[0][0],
						label,
						usd: money(e.usd),
					}))
					.sort((a, b) => b.usd - a.usd),
				unknownModelTokens,
			},
			lines,
		},
		tokensPerDay: [...perDay.values()],
		chartNote: cut ? "Showing the newest 366 days; earlier days are not in the chart." : null,
		recent: listSessions(db, { range: opts.range, repo: opts.repo, limit: RECENT, now: opts.now }).items,
		budget: opts.cfg ? getBudget(db, opts.cfg, opts.now) : null,
	};
}

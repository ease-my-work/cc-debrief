// buildRecap() (feature 17 "Behaviour"): session-days in range → hidden repos removed first, agent worktrees folded
// into their parent, groups by repo (busiest first), one bullet per session (or session-day), duplicates merged,
// file lines as base names. Pure over the database; no prompt text and no directory leaves this module.
import type { Config } from "../config";
import type { Db } from "../db/adapter";
import { localDate } from "../db/queries/range";
import { type RecapFile, type RecapRow, recapFiles, recapReads, recapRows } from "../db/queries/recap";
import { rangeBounds } from "./range";
import type { BulletSource, Recap, RecapActivity, RecapBullet, RecapDay, RecapGroup, RecapRange } from "./types";

const MAX_TEXT = 120;
const FILE_LINE = 3;
const BULLET_FILES = 3;
const BULLET_READS = 2;
const SLOTS = 96; // quarter hours of a day
const DAY_MS = 86_400_000;
const WORKTREE = "/.claude/worktrees/";

const collapse = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
const slash = (p: string) => p.replace(/\\/g, "/");
const baseName = (p: string) => slash(p).replace(/\/+$/, "").split("/").pop() ?? p;

// A run of path segments not inside a URL (nothing path-ish or ":" right before it).
const PATHISH = /(?<![\w:/\\.~-])(?:[A-Za-z]:)?[\\/~]*(?:[\w.@-]+[\\/]+)+[\w.@-]+/g;

/**
 * Paths in AI titles and summaries cut to their base name, so no directory reaches a recap or the polish prompt:
 * absolute (/x, C:\x, ~/x) or with two or more separators ("src/recap/build.ts"). One relative separator
 * ("Feat/ingest-worker") and URLs stay as they are.
 */
export function baseNamePaths(s: string): string {
	return s.replace(PATHISH, (m) => {
		const rooted = /^(?:[A-Za-z]:|[\\/~])/.test(m);
		const seps = m.match(/[\\/]+/g)?.length ?? 0;
		return rooted || seps >= 2 ? (m.split(/[\\/]+/).pop() ?? m) : m;
	});
}

/** Cut at a word boundary so text plus "…" fits in 120 characters. */
function cut(text: string): string {
	if (text.length <= MAX_TEXT) return text;
	const head = text.slice(0, MAX_TEXT - 1);
	const space = head.lastIndexOf(" ");
	return `${(space > 0 ? head.slice(0, space) : head).trimEnd()}…`;
}

/** The summary's first sentence: leading list markers and quotes trimmed, cut at the first ". ", "! " or "? ". */
function firstSentence(summary: string): string {
	const s = collapse(summary).replace(/^[-*"\s]+/, "");
	const m = /[.!?] /.exec(s);
	return m ? s.slice(0, m.index + 1) : s;
}

/** "a, b, c +N": the first `n` names and a count of the rest. */
const named = (names: string[], n: number) => {
	const rest = names.length - n;
	return `${names.slice(0, n).join(", ")}${rest > 0 ? ` +${rest}` : ""}`;
};

/**
 * Bullet text from the first source with a value: title → summary → agent name → files edited ("a.go, b.go, c.go +1")
 * → files read ("read backend.tf, iam.tf +5") → "Explored <repo>".
 */
export function bulletFor(s: {
	title: string | null;
	summary: string | null;
	agentName: string | null;
	files: string[];
	/** Base names the session read, most-read first (source explored). */
	reads?: string[];
	repo: string;
}): { text: string; source: BulletSource } {
	const title = baseNamePaths(collapse(s.title));
	if (title) return { text: cut(title), source: "title" };
	const summary = firstSentence(baseNamePaths(s.summary ?? ""));
	if (summary) return { text: cut(summary), source: "summary" };
	const agent = baseNamePaths(collapse(s.agentName));
	if (agent) return { text: cut(agent), source: "agent_name" };
	if (s.files.length > 0) return { text: cut(named(s.files, BULLET_FILES)), source: "files" };
	if (s.reads?.length) return { text: cut(`read ${named(s.reads, BULLET_READS)}`), source: "explored" };
	return { text: cut(`Explored ${s.repo}`), source: "explored" };
}

type RepoInfo = { repoId: string; name: string; root: string; remote: string | null };

/**
 * The id a recap may show: a network remote's host/org/repo. A remote-less repo's id is its root path, and a local-path
 * remote (git clone /some/dir) keeps that path as the id (feature 04), so both stay on the server.
 */
function publicId(r: RepoInfo): string | null {
	if (!r.remote) return null;
	return /^(?:[a-z]:|[/\\~.])/i.test(r.repoId) ? null : r.repoId;
}
/** `repoId` is shown only for a repo with a remote: a remote-less repo id is its root path (feature 04). */
type Key = { key: string; repo: string; repoId: string | null; id: string | null };

/** The group a row belongs to: a remote-less agent worktree folds into the repo at the path before the segment. */
function groupResolver(db: Db): (r: RecapRow) => Key {
	const repos = db
		.prepare("SELECT repo_id AS repoId, name, root_path AS root, remote_url AS remote FROM repos")
		.all<RepoInfo>();
	const byRoot = new Map(repos.map((r) => [slash(r.root).replace(/\/+$/, ""), r]));
	const byId = new Map(repos.map((r) => [r.repoId, r]));
	return (row) => {
		if (row.repoId === null) {
			const name = baseName(collapse(row.cwd)) || "no repo";
			return { key: `cwd:${name}`, repo: name, repoId: null, id: null };
		}
		const info = byId.get(row.repoId);
		const root = slash(info?.root ?? row.rootPath ?? "");
		const at = root.indexOf(WORKTREE);
		if (info && !info.remote && at > 0) {
			const parent = byRoot.get(root.slice(0, at));
			if (parent)
				return {
					key: `repo:${parent.repoId}`,
					repo: parent.name,
					repoId: publicId(parent),
					id: parent.repoId,
				};
		}
		return {
			key: `repo:${row.repoId}`,
			repo: row.repoName ?? baseName(root),
			repoId: info ? publicId(info) : null,
			id: row.repoId,
		};
	};
}

/** Base names by churn, descending (ties by name); a base name from two directories once, with its churn summed. */
function rankFiles(files: { path: string; churn: number }[]): string[] {
	const churn = new Map<string, number>();
	for (const f of files) churn.set(baseName(f.path), (churn.get(baseName(f.path)) ?? 0) + f.churn);
	return [...churn.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([n]) => n);
}

/** Turns per local quarter hour, per day with work, oldest day first (the view's activity strip). */
function activityOf(rows: RecapRow[]): RecapActivity[] {
	const days = new Map<string, number[]>();
	for (const r of rows) {
		let slots = days.get(r.day);
		if (!slots) {
			slots = new Array<number>(SLOTS).fill(0);
			days.set(r.day, slots);
		}
		for (const t of r.turnTimes) {
			const d = new Date(t);
			slots[d.getHours() * 4 + Math.floor(d.getMinutes() / 15)]++;
		}
	}
	return [...days.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([date, slots]) => ({ date, slots }));
}

type Unit = { key: Key; sessionId: string; day: string | null; turns: number; firstTurnAt: string; row: RecapRow };

/**
 * The recap for a range (feature 17). `now` (default: the clock) only sets `retentionCutoff`. Repos in
 * `recap.hiddenRepos` (name or id, case-insensitive) are removed before grouping, with their files.
 */
export function buildRecap(
	db: Db,
	cfg: Config,
	opts: { range: RecapRange; groupBy: "repo" | "day"; files: boolean; now?: Date },
): Recap {
	const { fromIso, toIso } = rangeBounds(opts.range);
	const now = opts.now ?? new Date();
	const hidden = new Set(cfg.recap.hiddenRepos.map((h) => h.toLowerCase()));
	const isHidden = (k: Key) => hidden.has(k.repo.toLowerCase()) || (k.id !== null && hidden.has(k.id.toLowerCase()));
	const resolve = groupResolver(db);

	const hiddenKeys = new Set<string>();
	const hiddenRepoIds = new Set<string>();
	const rows: { row: RecapRow; key: Key }[] = [];
	for (const row of recapRows(db, fromIso, toIso)) {
		const key = resolve(row);
		// A folded worktree can also be hidden by its own name or id, leaving its parent's other sessions.
		const own =
			row.repoId === null
				? false
				: hidden.has(row.repoId.toLowerCase()) || hidden.has((row.repoName ?? "").toLowerCase());
		if (isHidden(key)) {
			hiddenKeys.add(key.key);
			if (row.repoId) hiddenRepoIds.add(row.repoId);
			if (key.id) hiddenRepoIds.add(key.id);
		} else if (own && row.repoId) {
			hiddenKeys.add(`repo:${row.repoId}`);
			hiddenRepoIds.add(row.repoId);
		} else rows.push({ row, key });
	}
	// Every repo row whose own name or id is hidden, so their files drop out of other repos' bullets too.
	for (const r of db.prepare("SELECT repo_id AS repoId, name FROM repos").all<{ repoId: string; name: string }>())
		if (hidden.has(r.repoId.toLowerCase()) || hidden.has(r.name.toLowerCase())) hiddenRepoIds.add(r.repoId);
	const hiddenRoots = [...hiddenRepoIds].flatMap((id) => {
		const root = db.prepare("SELECT root_path AS root FROM repos WHERE repo_id = ?").get<{ root: string }>(id)?.root;
		return root ? [`${slash(root).replace(/\/+$/, "")}/`] : [];
	});
	const fileHidden = (f: RecapFile) =>
		(f.repoId !== null && hiddenRepoIds.has(f.repoId)) || hiddenRoots.some((r) => slash(f.path).startsWith(r));
	const pathHidden = (p: string) => hiddenRoots.some((r) => slash(p).startsWith(r));

	const ids = [...new Set(rows.map((r) => r.row.sessionId))];
	const files = recapFiles(db, ids, fromIso, toIso).filter((f) => !fileHidden(f));
	const byDay = opts.groupBy === "day";

	// One unit per session (by repo) or per session-day (by day).
	const units = new Map<string, Unit>();
	for (const { row, key } of rows) {
		const id = byDay ? `${row.sessionId}\u0001${row.day}` : row.sessionId;
		const u = units.get(id);
		if (u) {
			u.turns += row.turns;
			if (row.firstTurnAt < u.firstTurnAt) u.firstTurnAt = row.firstTurnAt;
		} else
			units.set(id, {
				key,
				sessionId: row.sessionId,
				day: byDay ? row.day : null,
				turns: row.turns,
				firstTurnAt: row.firstTurnAt,
				row,
			});
	}
	const filesBySession = new Map<string, RecapFile[]>();
	for (const f of files) {
		const list = filesBySession.get(f.sessionId);
		if (list) list.push(f);
		else filesBySession.set(f.sessionId, [f]);
	}
	const unitFiles = (u: Unit) =>
		(filesBySession.get(u.sessionId) ?? []).filter((f) => u.day === null || f.day === u.day);
	// Files read, for the bullet of a session that edited nothing; base names, most-read first.
	const readsBySession = new Map<string, { day: string; path: string; count: number }[]>();
	for (const r of recapReads(db, ids, fromIso, toIso)) {
		if (pathHidden(r.path)) continue;
		const list = readsBySession.get(r.sessionId);
		if (list) list.push(r);
		else readsBySession.set(r.sessionId, [r]);
	}
	const unitReads = (u: Unit) => {
		const count = new Map<string, number>();
		for (const r of readsBySession.get(u.sessionId) ?? [])
			if (u.day === null || r.day === u.day) count.set(baseName(r.path), (count.get(baseName(r.path)) ?? 0) + r.count);
		return [...count.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);
	};

	const groupsOf = (list: Unit[]): RecapGroup[] => {
		const groups = new Map<string, { group: RecapGroup; churn: Map<RecapBullet, RecapFile[]> }>();
		for (const u of [...list].sort((a, b) =>
			a.firstTurnAt < b.firstTurnAt ? -1 : a.firstTurnAt > b.firstTurnAt ? 1 : 0,
		)) {
			let g = groups.get(u.key.key);
			if (!g) {
				g = { group: { repo: u.key.repo, repoId: u.key.repoId, turns: 0, bullets: [] }, churn: new Map() };
				groups.set(u.key.key, g);
			}
			g.group.turns += u.turns;
			const own = unitFiles(u);
			const { text, source } = bulletFor({
				title: u.row.title,
				summary: u.row.summary,
				agentName: u.row.agentName,
				files: rankFiles(own),
				reads: own.length ? [] : unitReads(u),
				repo: u.key.repo,
			});
			const norm = text.trim().toLowerCase();
			const same = g.group.bullets.find((b) => b.text.trim().toLowerCase() === norm);
			if (same) {
				same.sessionIds.push(u.sessionId);
				g.churn.get(same)?.push(...own);
			} else {
				const b: RecapBullet = {
					text,
					source,
					files: [],
					moreFiles: 0,
					sessionIds: [u.sessionId],
					firstTurnAt: u.firstTurnAt,
				};
				g.group.bullets.push(b);
				g.churn.set(b, [...own]);
			}
		}
		for (const { group, churn } of groups.values())
			for (const b of group.bullets) {
				if (!opts.files || b.source === "files" || b.source === "explored") continue;
				const ranked = rankFiles(churn.get(b) ?? []);
				b.files = ranked.slice(0, FILE_LINE);
				b.moreFiles = Math.max(0, ranked.length - FILE_LINE);
			}
		return [...groups.values()].map((g) => g.group).sort((a, b) => b.turns - a.turns || a.repo.localeCompare(b.repo));
	};

	const all = [...units.values()];
	const days: RecapDay[] = byDay
		? [...new Set(all.map((u) => u.day as string))]
				.sort()
				.map((date) => ({ date, groups: groupsOf(all.filter((u) => u.day === date)) }))
		: [];
	const days0 = cfg.retention.days;
	return {
		range: opts.range,
		groupBy: opts.groupBy,
		groups: byDay ? [] : groupsOf(all),
		days,
		hiddenRepos: hiddenKeys.size,
		sessions: ids.length,
		retentionCutoff: days0 > 0 ? localDate(new Date(now.getTime() - days0 * DAY_MS)) : null,
		retentionDays: days0,
		activity: activityOf(rows.map((r) => r.row)),
	};
}

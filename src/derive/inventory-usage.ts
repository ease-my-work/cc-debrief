// Loaded vs invoked inventory per session (features 03 and 05). deriveSession() records the session's skill signals
// (listing names, dynamic_skill dirs, slash commands) from the lines it reads, in meta skills:<session_id>, merged on
// the append path. deriveInventoryUsage() rebuilds the session's inventory_usage rows from those signals, tool_calls
// and the current inventory, so a rescan can re-join sessions without reading their transcripts again.
import { dirname, resolve, sep } from "node:path";
import { type InventoryItem, scanRepo, scanUser, upsertInventory } from "../collector/inventory";
import type { StoredLine } from "../collector/transcript";
import type { Db } from "../db/adapter";
import { getMeta, setMeta } from "../db/queries/meta";
import { decodePayload } from "../ingest/line";

export type SkillSignals = {
	hasListing: boolean;
	listed: string[]; // skill_listing names (initial set plus deltas)
	dynamic: { names: string[]; dir: string | null }[]; // dynamic_skill attachments
	commands: string[]; // slash commands run on user lines, without the "/"
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : []);

const EMPTY: SkillSignals = { hasListing: false, listed: [], dynamic: [], commands: [] };

// Claude Code's own slash commands; a skill of the same name is not run by them.
const BUILTIN_COMMANDS = new Set(
	(
		"add-dir agents bashes bug clear compact config context cost doctor exit export fast feedback help hooks ide init " +
		"install-github-app login logout mcp memory model output-style permissions plugin plugins pr-comments " +
		"privacy-settings release-notes resume rewind review security-review skills status statusline terminal-setup " +
		"theme todos upgrade usage vim"
	).split(" "),
);
const COMMAND_RE = /<command-name>\/?([^<\s]+)<\/command-name>/g;

function userText(line: StoredLine): string {
	const m = line.payload.message;
	const c = isObj(m) ? m.content : undefined;
	if (typeof c === "string") return c;
	if (!Array.isArray(c)) return "";
	return c
		.filter((b) => isObj(b) && b.type === "text" && typeof b.text === "string")
		.map((b) => (b as { text: string }).text)
		.join("\n");
}

/** Skill signals from transcript lines (pure). invoked_skills attachments are ignored (Phase 0 A7). */
export function skillSignals(lines: StoredLine[]): SkillSignals {
	const s: SkillSignals = { hasListing: false, listed: [], dynamic: [], commands: [] };
	for (const l of lines) {
		const a = l.payload.attachment;
		if (l.type === "attachment" && isObj(a)) {
			if (a.type === "skill_listing") {
				s.hasListing = true;
				s.listed.push(...strings(a.names));
			} else if (a.type === "dynamic_skill") {
				s.dynamic.push({ names: strings(a.skillNames), dir: typeof a.skillDir === "string" ? a.skillDir : null });
			}
		} else if (l.type === "user") {
			for (const m of userText(l).matchAll(COMMAND_RE)) s.commands.push(m[1]);
		}
	}
	return mergeSignals(EMPTY, s);
}

/** Union of two signal sets, deduplicated. */
export function mergeSignals(a: SkillSignals, b: SkillSignals): SkillSignals {
	const dyn = new Map([...a.dynamic, ...b.dynamic].map((d) => [JSON.stringify(d), d]));
	return {
		hasListing: a.hasListing || b.hasListing,
		listed: [...new Set([...a.listed, ...b.listed])],
		dynamic: [...dyn.values()],
		commands: [...new Set([...a.commands, ...b.commands])],
	};
}

const signalsKey = (sessionId: string) => `skills:${sessionId}`;

function readSignals(db: Db, sessionId: string): SkillSignals | null {
	const raw = getMeta(db, signalsKey(sessionId));
	if (!raw) return null;
	try {
		return mergeSignals(EMPTY, JSON.parse(raw));
	} catch {
		return null;
	}
}

/** Stores the signals of `lines`: replacing the stored set (full derive) or adding to it (append derive). */
export function recordSkillSignals(db: Db, sessionId: string, lines: StoredLine[], replace: boolean): void {
	const fresh = skillSignals(lines);
	// A session derived before Phase 2 has no stored signals: seed them from all its stored lines (the new ones
	// included), or its earlier listing and slash commands would be lost.
	const merged = replace
		? fresh
		: mergeSignals(readSignals(db, sessionId) ?? signalsFromStoredLines(db, sessionId), fresh);
	setMeta(db, signalsKey(sessionId), JSON.stringify(merged));
}

export function forgetSkillSignals(db: Db, sessionId: string): void {
	db.prepare("DELETE FROM meta WHERE key = ?").run(signalsKey(sessionId));
}

/** Signals from the stored lines that can carry them (one-time, for sessions derived before Phase 2). */
function signalsFromStoredLines(db: Db, sessionId: string): SkillSignals {
	const rows = db
		.prepare(
			`SELECT type, subtype, payload FROM transcript_lines
			 WHERE session_id = ? AND (subtype IN ('skill_listing', 'dynamic_skill') OR type = 'user') ORDER BY id`,
		)
		.all<{ type: string; subtype: string | null; payload: Uint8Array }>(sessionId);
	return skillSignals(
		rows.map((r) => ({
			lineNo: 0,
			agentId: null,
			uuid: null,
			type: r.type,
			subtype: r.subtype,
			ts: null,
			payload: decodePayload(r.payload) as Obj,
		})),
	);
}

type RawRow = {
	id: number;
	scope: string;
	repo_id: string | null;
	kind: string;
	name: string;
	path: string;
	meta: string;
};
type InvRow = Omit<RawRow, "meta"> & { meta: Obj };
const withMeta = (r: RawRow): InvRow => {
	let meta: Obj = {};
	try {
		const m: unknown = JSON.parse(r.meta);
		if (isObj(m)) meta = m;
	} catch {}
	return { ...r, meta };
};
const norm = (p: string, base = ""): string => {
	const r = resolve(base, p);
	return process.platform === "win32" ? r.toLowerCase() : r;
};
const inside = (path: string, dir: string) => path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep);

const FILE_TOOLS = ["Read", "Edit", "Write", "MultiEdit", "NotebookEdit", "Glob", "Grep"];

/** Paths named by the session's file tool calls (fallback only); relative ones resolve against the session's cwd. */
function touchedPaths(db: Db, sessionId: string, cwd: string | null): string[] {
	const rows = db
		.prepare(
			`SELECT input FROM tool_calls WHERE session_id = ? AND tool_name IN (${FILE_TOOLS.map(() => "?").join(", ")})`,
		)
		.all<{ input: Uint8Array | null }>(sessionId, ...FILE_TOOLS);
	const out: string[] = [];
	for (const r of rows) {
		if (!r.input) continue;
		const input = decodePayload(r.input);
		if (!isObj(input)) continue;
		for (const k of ["file_path", "notebook_path", "path"])
			if (typeof input[k] === "string") out.push(norm(input[k], cwd ?? ""));
	}
	return out;
}

/**
 * Deletes and rebuilds the session's inventory_usage rows. Skills loaded = listed names (else the scan-based
 * fallback); MCP loaded = user, this repo's and enabled plugins' servers; invoked = Skill calls, slash commands and
 * matching MCP calls. Listed names with no inventory row get a transcript-only row.
 */
export function deriveInventoryUsage(db: Db, sessionId: string): void {
	const session = db
		.prepare("SELECT repo_id, cwd, started_at FROM sessions WHERE session_id = ?")
		.get<{ repo_id: string | null; cwd: string | null; started_at: string | null }>(sessionId);
	if (!session) return;
	let signals = readSignals(db, sessionId);
	if (!signals) {
		signals = signalsFromStoredLines(db, sessionId);
		setMeta(db, signalsKey(sessionId), JSON.stringify(signals));
	}
	const repoId = session.repo_id;

	const inventory = db
		.prepare(
			`SELECT id, scope, repo_id, kind, name, path, meta FROM inventory
			 WHERE agent = 'claude-code' AND kind IN ('skill', 'mcp', 'plugin', 'agent', 'command')
			   AND (scope != 'repo' OR repo_id IS ?)`,
		)
		.all<RawRow>(repoId)
		.map(withMeta);
	// A plugin's enabled state: the repo's .claude/settings.json entry when it has one (project settings win), else the
	// user's. The query above keeps only this session's repo rows.
	const pluginEnabled = new Map<string, boolean>();
	for (const scope of ["plugin", "repo"])
		for (const r of inventory)
			if (r.kind === "plugin" && r.scope === scope && typeof r.meta.enabled === "boolean")
				pluginEnabled.set(r.name, r.meta.enabled);
	const enabledPlugins = new Set([...pluginEnabled].filter(([, on]) => on).map(([name]) => name));
	const skills = inventory.filter((r) => r.kind === "skill");
	const mcp = inventory.filter((r) => r.kind === "mcp");
	const loaded = new Set<number>();
	const invoked = new Set<number>();

	// Skills loaded.
	if (signals.hasListing) {
		const dynamicNames = new Set(signals.dynamic.flatMap((d) => d.names));
		const names = new Set([...signals.listed, ...dynamicNames]);
		for (const name of names) {
			// Installed rows win over transcript-only ones, so a guess made before the repo was known is dropped.
			const named = skills.filter((r) => r.name === name);
			const installed = named.filter((r) => r.meta.source !== "transcript");
			const matches = installed.length > 0 ? installed : named;
			if (matches.length === 0) {
				const scope = dynamicNames.has(name) ? "repo" : name.includes(":") ? "plugin" : "user";
				const created = transcriptRow(db, scope, scope === "repo" ? repoId : null, name, session.started_at);
				matches.push(created);
				skills.push(created); // so a Skill call or slash command below can mark it invoked
			}
			for (const r of matches) loaded.add(r.id);
		}
	} else {
		const subtrees: string[] = [
			...touchedPaths(db, sessionId, session.cwd),
			...(session.cwd ? [norm(session.cwd)] : []),
		];
		for (const r of skills) {
			const meta = r.meta;
			if (meta.source === "transcript") continue;
			const plugin = typeof meta.plugin === "string" ? meta.plugin : null;
			const lazyRoot = r.path ? norm(dirname(dirname(dirname(r.path)))) : null; // <sub>/.claude/skills/<name>
			if (
				r.scope === "user" ||
				(r.scope === "plugin" && plugin !== null && enabledPlugins.has(plugin)) ||
				(r.scope === "repo" && meta.load !== "lazy") ||
				(r.scope === "repo" && lazyRoot !== null && subtrees.some((p) => inside(p, lazyRoot)))
			) {
				loaded.add(r.id);
			}
		}
	}

	// Skills invoked: Skill calls and slash commands (a user and a repo skill of one name are both marked). A plugin
	// skill, stored as <plugin>:<skill>, matches in either form (feature 03).
	const calls = db
		.prepare("SELECT DISTINCT skill_name, mcp_server, mcp_source FROM tool_calls WHERE session_id = ?")
		.all<{ skill_name: string | null; mcp_server: string | null; mcp_source: string | null }>(sessionId);
	const invokedNames = new Set([
		...calls.flatMap((c) => (c.skill_name ? [c.skill_name] : [])),
		...signals.commands.filter((c) => !BUILTIN_COMMANDS.has(c)),
	]);
	for (const r of skills) {
		const plugin = typeof r.meta.plugin === "string" ? r.meta.plugin : null;
		const bare = plugin !== null && r.name.startsWith(`${plugin}:`) ? r.name.slice(plugin.length + 1) : null;
		if (invokedNames.has(r.name) || (bare !== null && invokedNames.has(bare))) invoked.add(r.id);
	}

	// MCP loaded: user servers, this repo's servers (query already limits repo scope), enabled plugins' servers.
	for (const r of mcp) {
		const plugin = r.meta.plugin;
		if (r.scope !== "plugin" || (typeof plugin === "string" && enabledPlugins.has(plugin))) loaded.add(r.id);
	}
	// MCP invoked: plugin servers by their plugin source, others by name (case-insensitively, feature 03) with no
	// source; claude.ai matches nothing.
	for (const c of calls) {
		if (!c.mcp_server || c.mcp_source === "claude.ai") continue;
		for (const r of mcp) {
			if (r.name.toLowerCase() !== c.mcp_server.toLowerCase()) continue;
			const plugin = r.meta.plugin;
			if (c.mcp_source === null ? r.scope !== "plugin" : r.scope === "plugin" && c.mcp_source === `plugin:${plugin}`) {
				invoked.add(r.id);
			}
		}
	}

	// Agents and commands (Phase 7 P11): available = user, this repo's and enabled plugins'; an agent is invoked by a
	// subagent of its type, a command by its slash command. A plugin's item matches as <plugin>:<name> or <name>.
	const agentTypes = new Set(
		db
			.prepare("SELECT DISTINCT agent_type FROM subagents WHERE session_id = ? AND agent_type IS NOT NULL")
			.all<{ agent_type: string }>(sessionId)
			.map((r) => r.agent_type),
	);
	const commands = new Set(signals.commands);
	for (const r of inventory) {
		if (r.kind !== "agent" && r.kind !== "command") continue;
		const plugin = typeof r.meta.plugin === "string" ? r.meta.plugin : null;
		if (r.scope === "plugin" && (plugin === null || !enabledPlugins.has(plugin))) continue;
		loaded.add(r.id);
		const bare = plugin !== null && r.name.startsWith(`${plugin}:`) ? r.name.slice(plugin.length + 1) : null;
		const used = r.kind === "agent" ? agentTypes : commands;
		if (used.has(r.name) || (bare !== null && used.has(bare))) invoked.add(r.id);
	}

	db.prepare("DELETE FROM inventory_usage WHERE session_id = ?").run(sessionId);
	const insert = db.prepare(
		"INSERT INTO inventory_usage (inventory_id, session_id, loaded, invoked) VALUES (?, ?, 1, ?)",
	);
	// Anything invoked was loaded.
	for (const id of new Set([...loaded, ...invoked])) insert.run(id, sessionId, invoked.has(id) ? 1 : 0);
	// Transcript-only rows no session uses any more (e.g. created before the session's repo was known).
	db.prepare(
		`DELETE FROM inventory WHERE json_extract(meta, '$.source') = 'transcript'
		   AND NOT EXISTS (SELECT 1 FROM inventory_usage u WHERE u.inventory_id = inventory.id)`,
	).run();
}

/** The transcript-only row for a listed name with no installed match (created, or found and its last_seen raised). */
function transcriptRow(db: Db, scope: string, repoId: string | null, name: string, startedAt: string | null): InvRow {
	const ts = startedAt ?? new Date().toISOString();
	const find = () =>
		db
			.prepare(
				`SELECT id, scope, repo_id, kind, name, path, meta FROM inventory
				 WHERE agent = 'claude-code' AND scope = ? AND COALESCE(repo_id, '') = ? AND kind = 'skill' AND name = ?`,
			)
			.get<RawRow>(scope, repoId ?? "", name);
	const existing = find();
	if (existing) {
		db.prepare("UPDATE inventory SET last_seen = max(last_seen, ?) WHERE id = ?").run(ts, existing.id);
		return withMeta(existing);
	}
	db.prepare(
		`INSERT INTO inventory (scope, repo_id, kind, name, path, description, first_seen, last_seen, meta)
		 VALUES (?, ?, 'skill', ?, '', NULL, ?, ?, '{"source":"transcript"}')`,
	).run(scope, repoId, name, ts, ts);
	return withMeta(find() as RawRow);
}

const RECENT_DAYS = 30;

/**
 * Stores a scan: transcript-only skill rows the scan found become the scanned rows in place (same id, usage kept),
 * then upsertInventory(), then deriveInventoryUsage() for the scope's sessions started in the last 30 days. A row
 * moves into a repo's scope only when it fits: it is that repo's own, or every session using it is in that repo; so
 * another repo's sessions never end up counting this repo's skill (review A7).
 */
export function applyScan(
	db: Db,
	items: InventoryItem[],
	scopeKey: string,
	now: Date = new Date(),
): { inserted: number; updated: number; rederived: number } {
	return db.transaction(() => {
		type TranscriptRow = { id: number; name: string; repo_id: string | null };
		const transcriptRows = db
			.prepare(
				`SELECT id, name, repo_id FROM inventory
				 WHERE agent = 'claude-code' AND kind = 'skill' AND json_extract(meta, '$.source') = 'transcript'`,
			)
			.all<TranscriptRow>();
		const byName = new Map<string, TranscriptRow[]>();
		for (const r of transcriptRows) byName.set(r.name, [...(byName.get(r.name) ?? []), r]);
		const usedOutside = db.prepare(
			`SELECT 1 AS x FROM inventory_usage u JOIN sessions s ON s.session_id = u.session_id
			 WHERE u.inventory_id = ? AND s.repo_id IS NOT ? LIMIT 1`,
		);
		const fits = (r: TranscriptRow, repoId: string | null) =>
			repoId === null || r.repo_id === repoId || (r.repo_id === null && !usedOutside.get(r.id, repoId));
		const taken = db.prepare(
			`SELECT 1 AS x FROM inventory
			 WHERE agent = 'claude-code' AND scope = ? AND COALESCE(repo_id, '') = ? AND kind = 'skill' AND name = ?`,
		);
		const move = db.prepare("UPDATE inventory SET scope = ?, repo_id = ? WHERE id = ?");
		for (const item of items) {
			const rows = item.kind === "skill" ? byName.get(item.name) : undefined;
			if (!rows?.length || taken.get(item.scope, item.repoId ?? "", item.name)) continue;
			const i = rows.findIndex((r) => fits(r, item.repoId));
			if (i < 0) continue;
			// One transcript row takes the scanned identity; upsertInventory() below sets its path, description and meta.
			move.run(item.scope, item.repoId, rows.splice(i, 1)[0].id);
		}

		const counts = upsertInventory(db, items, scopeKey, now);
		const since = new Date(now.getTime() - RECENT_DAYS * 86_400_000).toISOString();
		const repoId = scopeKey.startsWith("repo:") ? scopeKey.slice("repo:".length) : null;
		const sessions =
			repoId === null
				? db.prepare("SELECT session_id FROM sessions WHERE started_at >= ?").all<{ session_id: string }>(since)
				: db
						.prepare("SELECT session_id FROM sessions WHERE started_at >= ? AND repo_id = ?")
						.all<{ session_id: string }>(since, repoId);
		for (const s of sessions) deriveInventoryUsage(db, s.session_id);
		return { ...counts, rederived: sessions.length };
	});
}

/** scanUser() (with the known repos) stored through applyScan(); returns what was found. */
export function scanUserInto(db: Db, now: Date = new Date()): InventoryItem[] {
	const repos = db
		.prepare("SELECT repo_id AS repoId, root_path AS rootPath FROM repos WHERE root_path IS NOT NULL")
		.all<{ repoId: string; rootPath: string }>();
	const items = scanUser({ repos });
	applyScan(db, items, "user", now);
	return items;
}

/** scanRepo() for one repo stored through applyScan(); returns what was found. */
export function scanRepoInto(db: Db, root: string, repoId: string, now: Date = new Date()): InventoryItem[] {
	const items = scanRepo(root, repoId);
	applyScan(db, items, `repo:${repoId}`, now);
	return items;
}

/**
 * Sessions derived before Phase 2 have no stored skill signals, and a scan re-derives only the last 30 days, so older
 * ones never got inventory_usage rows (their skills' last use was lost). Derives up to `limit` of them; each derive
 * stores the session's signals, so the job resumes where it stopped. Returns how many were derived.
 */
export function deriveMissingInventoryUsage(db: Db, limit: number): number {
	const ids = db
		.prepare(
			`SELECT session_id FROM sessions s
			 WHERE NOT EXISTS (SELECT 1 FROM meta m WHERE m.key = 'skills:' || s.session_id)
			 ORDER BY started_at DESC LIMIT ?`,
		)
		.all<{ session_id: string }>(limit);
	db.transaction(() => {
		for (const s of ids) deriveInventoryUsage(db, s.session_id);
	});
	return ids.length;
}

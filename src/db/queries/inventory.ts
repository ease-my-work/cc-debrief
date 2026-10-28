// GET /api/inventory (features 05, 12). Counts are over sessions in the range (and repo); status is relative to now:
// active = invoked in the last 30 days, unused_30d = invoked before that only, never_used = never invoked.
import { estimateContextTokens, workspaceDir } from "../../collector/inventory";
import type { InventoryItemRow, InventoryKind, InventoryResponse, InventoryStatus, Range } from "../../server/types";
import type { Db } from "../adapter";
import { getMeta } from "./meta";
import { rangeStart } from "./range";
import { median, msBetween } from "./stats";

const ACTIVE_DAYS = 30;
/** Kinds with no invocation record (Phase 7 P11): never "unused", shown as "usage not recorded". */
const NO_USAGE = new Set<InventoryKind>(["output_style", "rule", "workflow"]);

type Obj = Record<string, unknown>;
type InvRow = {
	id: number;
	scope: "user" | "plugin" | "repo";
	repo_id: string | null;
	kind: InventoryKind;
	name: string;
	path: string;
	description: string | null;
	last_seen: string;
	meta: Obj;
};

export type InventoryQuery = { kind: InventoryKind; range: Range; repo?: string; unused?: boolean; now: Date };

/** The sessions-in-range subquery and its parameters. */
export function sessionScope(range: Range, repo: string | undefined, now: Date): { sql: string; params: unknown[] } {
	return {
		sql: `SELECT session_id FROM sessions WHERE started_at >= ?${repo ? " AND repo_id = ?" : ""}`,
		params: [rangeStart(range, now), ...(repo ? [repo] : [])],
	};
}

function parse(meta: string): Obj {
	try {
		const v: unknown = JSON.parse(meta);
		return v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {};
	} catch {
		return {};
	}
}

const statusOf = (lastInvoked: string | null, activeSince: string): InventoryStatus =>
	lastInvoked === null ? "never_used" : lastInvoked >= activeSince ? "active" : "unused_30d";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function getInventory(db: Db, q: InventoryQuery): InventoryResponse {
	const scope = sessionScope(q.range, q.repo, q.now);
	const activeSince = new Date(q.now.getTime() - ACTIVE_DAYS * 86_400_000).toISOString();
	const repoNames = new Map(
		db
			.prepare("SELECT repo_id, name FROM repos")
			.all<{ repo_id: string; name: string }>()
			.map((r) => [r.repo_id, r.name]),
	);
	const lastScan = (r: InvRow) =>
		getMeta(
			db,
			r.scope === "repo" && r.meta.source !== "claude.json" ? `last_scan_repo:${r.repo_id}` : "last_scan_user",
		);

	const rows = db
		.prepare(
			`SELECT id, scope, repo_id, kind, name, path, description, last_seen, meta FROM inventory
			 WHERE agent = 'claude-code' AND kind = ?${q.repo ? " AND (scope != 'repo' OR repo_id = ?)" : ""}`,
		)
		.all<Omit<InvRow, "meta"> & { meta: string }>(q.kind, ...(q.repo ? [q.repo] : []))
		.map((r): InvRow => ({ ...r, meta: parse(r.meta) }));

	// Range counts and all-time last invocation per item.
	const counts = new Map(
		db
			.prepare(
				`SELECT inventory_id AS id, sum(loaded) AS loaded, sum(invoked) AS invoked FROM inventory_usage
				 WHERE session_id IN (${scope.sql}) GROUP BY inventory_id`,
			)
			.all<{ id: number; loaded: number; invoked: number }>(...scope.params)
			.map((r) => [r.id, r]),
	);
	const lastInvoked = new Map(
		db
			.prepare(
				`SELECT u.inventory_id AS id, max(s.started_at) AS last FROM inventory_usage u
				 JOIN sessions s ON s.session_id = u.session_id WHERE u.invoked = 1 GROUP BY u.inventory_id`,
			)
			.all<{ id: number; last: string }>()
			.map((r) => [r.id, r.last]),
	);

	const source = (r: InvRow): string => {
		const repoName = r.repo_id ? (repoNames.get(r.repo_id) ?? r.repo_id) : "";
		if (r.scope === "plugin") return typeof r.meta.plugin === "string" ? r.meta.plugin : r.name.split(":")[0];
		if (r.scope === "user") return "user";
		if (r.kind === "skill") return `${repoName}/.claude/skills`;
		const dir = workspaceDir(r.kind);
		if (dir) return `${repoName}/.claude/${dir}`;
		if (r.kind === "mcp")
			return r.meta.source === "claude.json" ? `${repoName} (~/.claude.json)` : `${repoName}/.mcp.json`;
		return `${repoName}/.claude/settings.json`;
	};

	let items: InventoryItemRow[] = rows.map((r) => {
		const c = counts.get(r.id);
		const last = lastInvoked.get(r.id) ?? null;
		return {
			id: r.id,
			name: r.name,
			source: source(r),
			scope: r.scope,
			path: r.path,
			sessionsLoaded: c?.loaded ?? 0,
			sessionsInvoked: c?.invoked ?? 0,
			lastUsed: last,
			ctxTokens: r.kind === "skill" ? estimateContextTokens(r.description) : 0,
			status: NO_USAGE.has(r.kind) ? "active" : statusOf(last, activeSince),
			removed: r.last_seen < (lastScan(r) ?? ""),
			usageRecorded: !NO_USAGE.has(r.kind) && r.kind !== "hook",
		};
	});

	if (q.kind === "mcp") items = withMcpStats(db, items, rows, scope, activeSince);
	if (q.kind === "plugin") items = withPluginStats(db, items, rows, scope, activeSince);
	if (q.kind === "hook") {
		const byId = new Map(rows.map((r) => [r.id, r]));
		items = items.map((i) => ({
			...i,
			provides: String(byId.get(i.id)?.meta.event ?? ""),
			status: "active" as const, // hooks run on their event; they have no invocation record
		}));
	}

	// The strip covers what is installed now (not removed), whatever the unused toggle shows.
	const present = items.filter((i) => !i.removed);
	const strip: InventoryResponse["strip"] = {
		installed: present.length,
		byScope: {
			user: present.filter((i) => i.scope === "user").length,
			plugin: present.filter((i) => i.scope === "plugin").length,
			repo: present.filter((i) => i.scope === "repo").length,
		},
		invoked: present.filter((i) => i.sessionsInvoked > 0).length,
		neverInvoked: present.filter((i) => i.status === "never_used").length,
		unusedCtxTokensPerSession: q.kind === "skill" ? unusedContextCost(db, items, scope) : 0,
	};

	if (q.unused) items = items.filter((i) => i.status !== "active");
	items.sort((a, b) => b.sessionsLoaded - a.sessionsLoaded || a.name.localeCompare(b.name));
	return { strip, items };
}

/** Mean, over sessions in scope that loaded any skill, of the summed ctx tokens of loaded non-active skills. */
function unusedContextCost(db: Db, items: InventoryItemRow[], scope: { sql: string; params: unknown[] }): number {
	const unusedTokens = new Map(items.filter((i) => i.status !== "active").map((i) => [i.id, i.ctxTokens]));
	const perSession = new Map<string, number>();
	for (const r of db
		.prepare(
			`SELECT u.session_id, u.inventory_id FROM inventory_usage u JOIN inventory i ON i.id = u.inventory_id
			 WHERE i.kind = 'skill' AND u.loaded = 1 AND u.session_id IN (${scope.sql})`,
		)
		.all<{ session_id: string; inventory_id: number }>(...scope.params)) {
		perSession.set(r.session_id, (perSession.get(r.session_id) ?? 0) + (unusedTokens.get(r.inventory_id) ?? 0));
	}
	if (perSession.size === 0) return 0;
	return Math.round([...perSession.values()].reduce((a, b) => a + b, 0) / perSession.size);
}

type CallRow = {
	session_id: string;
	mcp_server: string;
	mcp_source: string | null;
	started_at: string | null;
	ended_at: string | null;
	ok: number | null;
	denied: string | null;
};

/**
 * MCP extras: tools ever seen, calls / failures / median ms in scope. Servers that were called but have no inventory
 * row (claude.ai connectors, or a local-scope server added in a repo subdirectory) are listed from their calls.
 */
function withMcpStats(
	db: Db,
	items: InventoryItemRow[],
	rows: InvRow[],
	scope: { sql: string; params: unknown[] },
	activeSince: string,
): InventoryItemRow[] {
	// Server names match case-insensitively (feature 03).
	const key = (server: string, source: string | null) => JSON.stringify([source, server.toLowerCase()]);
	const itemKey = (r: InvRow) => key(r.name, r.scope === "plugin" ? `plugin:${String(r.meta.plugin ?? "")}` : null);
	const tools = new Map(
		db
			.prepare(
				`SELECT lower(mcp_server) AS mcp_server, mcp_source, count(DISTINCT mcp_tool) AS n FROM tool_calls
				 WHERE mcp_server IS NOT NULL GROUP BY lower(mcp_server), mcp_source`,
			)
			.all<{ mcp_server: string; mcp_source: string | null; n: number }>()
			.map((r) => [key(r.mcp_server, r.mcp_source), r.n]),
	);
	const calls = new Map<string, CallRow[]>();
	for (const c of db
		.prepare(
			`SELECT session_id, mcp_server, mcp_source, started_at, ended_at, ok, denied FROM tool_calls
			 WHERE mcp_server IS NOT NULL AND session_id IN (${scope.sql})`,
		)
		.all<CallRow>(...scope.params)) {
		const k = key(c.mcp_server, c.mcp_source);
		calls.set(k, [...(calls.get(k) ?? []), c]);
	}
	const stats = (k: string) => {
		const list = calls.get(k) ?? [];
		const ms = list.map(msBetween).filter((x): x is number => x !== null);
		const m = median(ms);
		return {
			tools: tools.get(k) ?? 0,
			calls: list.length,
			failures: list.filter((c) => c.ok === 0 && c.denied === null).length, // denials are not failures (feature 03)
			...(m === null ? {} : { medianMs: m }),
		};
	};
	const byId = new Map(rows.map((r) => [r.id, r]));
	const out = items.map((i) => {
		const r = byId.get(i.id);
		return r ? { ...i, ...stats(itemKey(r)) } : i;
	});

	// Called servers with no inventory row: claude.ai connectors have no local config (feature 05), and a server
	// configured somewhere the scan does not read still has calls that must not vanish.
	const known = new Set(rows.map(itemKey));
	const lastCall = new Map<string, string>();
	for (const r of db
		.prepare(
			`SELECT c.mcp_server, c.mcp_source, max(s.started_at) AS last FROM tool_calls c
			 JOIN sessions s ON s.session_id = c.session_id WHERE c.mcp_server IS NOT NULL GROUP BY c.mcp_server, c.mcp_source`,
		)
		.all<{ mcp_server: string; mcp_source: string | null; last: string }>()) {
		const k = key(r.mcp_server, r.mcp_source);
		if (!lastCall.has(k) || r.last > (lastCall.get(k) as string)) lastCall.set(k, r.last);
	}
	let synthetic = 0;
	for (const [k, list] of calls) {
		if (known.has(k)) continue;
		const { mcp_server: server, mcp_source: callSource } = list[0];
		const plugin = callSource?.startsWith("plugin:") ? callSource.slice("plugin:".length) : null;
		const sessions = new Set(list.map((c) => c.session_id)).size;
		const last = lastCall.get(k) ?? null;
		out.push({
			id: -++synthetic,
			name: server,
			source: callSource === "claude.ai" ? "claude.ai" : (plugin ?? "no config found"),
			scope: plugin !== null ? "plugin" : "user",
			path: "",
			sessionsLoaded: sessions,
			sessionsInvoked: sessions,
			lastUsed: last,
			ctxTokens: 0,
			status: statusOf(last, activeSince),
			removed: false,
			...stats(k),
		});
	}
	return out;
}

/** Plugins: what they provide, sessions where any of their skills or MCP servers loaded / ran, status from those. */
function withPluginStats(
	db: Db,
	items: InventoryItemRow[],
	rows: InvRow[],
	scope: { sql: string; params: unknown[] },
	activeSince: string,
): InventoryItemRow[] {
	const provided = new Map<string | null, { skill: number; mcp: number }>();
	for (const r of db
		.prepare(
			`SELECT json_extract(meta, '$.plugin') AS plugin, kind, count(*) AS n FROM inventory
			 WHERE kind IN ('skill', 'mcp') AND scope = 'plugin' GROUP BY plugin, kind`,
		)
		.all<{ plugin: string | null; kind: "skill" | "mcp"; n: number }>()) {
		const p = provided.get(r.plugin) ?? { skill: 0, mcp: 0 };
		p[r.kind] = r.n;
		provided.set(r.plugin, p);
	}
	const providesText = (plugin: string): string => {
		const p = provided.get(plugin) ?? { skill: 0, mcp: 0 };
		return [plural(p.skill, "skill"), ...(p.mcp > 0 ? [plural(p.mcp, "MCP server")] : [])].join(" · ");
	};
	const usage = new Map<string, { loaded: Set<string>; invoked: Set<string> }>();
	for (const r of db
		.prepare(
			`SELECT json_extract(i.meta, '$.plugin') AS plugin, u.session_id, u.loaded, u.invoked
			 FROM inventory_usage u JOIN inventory i ON i.id = u.inventory_id
			 WHERE i.kind IN ('skill', 'mcp') AND i.scope = 'plugin' AND u.session_id IN (${scope.sql})`,
		)
		.all<{ plugin: string | null; session_id: string; loaded: number; invoked: number }>(...scope.params)) {
		if (!r.plugin) continue;
		const u = usage.get(r.plugin) ?? { loaded: new Set<string>(), invoked: new Set<string>() };
		if (r.loaded) u.loaded.add(r.session_id);
		if (r.invoked) u.invoked.add(r.session_id);
		usage.set(r.plugin, u);
	}
	const lastInvoked = new Map(
		db
			.prepare(
				`SELECT json_extract(i.meta, '$.plugin') AS plugin, max(s.started_at) AS last
				 FROM inventory_usage u JOIN inventory i ON i.id = u.inventory_id JOIN sessions s ON s.session_id = u.session_id
				 WHERE i.kind IN ('skill', 'mcp') AND i.scope = 'plugin' AND u.invoked = 1 GROUP BY plugin`,
			)
			.all<{ plugin: string | null; last: string }>()
			.map((r) => [r.plugin, r.last]),
	);
	const byId = new Map(rows.map((r) => [r.id, r]));
	return items.map((i) => {
		const r = byId.get(i.id);
		const u = usage.get(i.name);
		const last = lastInvoked.get(i.name) ?? null;
		return {
			...i,
			sessionsLoaded: u?.loaded.size ?? 0,
			sessionsInvoked: u?.invoked.size ?? 0,
			lastUsed: last,
			status: statusOf(last, activeSince),
			provides: providesText(i.name),
			enabled: typeof r?.meta.enabled === "boolean" ? r.meta.enabled : null,
		};
	});
}

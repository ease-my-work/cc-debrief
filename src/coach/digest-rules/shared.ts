// Helpers shared by the digest rules (feature 09).
import type { Db } from "../../db/adapter";
import { getMeta } from "../../db/queries/meta";

export const DAY_MS = 86_400_000;
export const daysBefore = (now: Date, days: number) => new Date(now.getTime() - days * DAY_MS).toISOString();

export type InventoryRow = {
	id: number;
	scope: "user" | "repo" | "plugin";
	repo_id: string | null;
	name: string;
	description: string | null;
	meta: Record<string, unknown>;
};

/** Inventory items of a kind that the last scan of their scope still saw (removed ones are left out, as in 05). */
export function presentItems(db: Db, kind: "skill" | "mcp"): InventoryRow[] {
	const scans = new Map<string, string | null>();
	const lastScan = (key: string) => {
		if (!scans.has(key)) scans.set(key, getMeta(db, key));
		return scans.get(key) ?? "";
	};
	return db
		.prepare(
			`SELECT id, scope, repo_id, name, description, meta, last_seen FROM inventory
			 WHERE agent = 'claude-code' AND kind = ? ORDER BY id`,
		)
		.all<Omit<InventoryRow, "meta"> & { meta: string; last_seen: string }>(kind)
		.map((r) => {
			let meta: Record<string, unknown> = {};
			try {
				const m = JSON.parse(r.meta);
				if (m && typeof m === "object" && !Array.isArray(m)) meta = m;
			} catch {
				// keep {}
			}
			return { ...r, meta };
		})
		.filter((r) => {
			const key =
				r.scope === "repo" && r.meta.source !== "claude.json" ? `last_scan_repo:${r.repo_id}` : "last_scan_user";
			return r.last_seen >= lastScan(key);
		})
		.map(({ last_seen: _, ...r }) => r);
}

/**
 * Sessions an inventory item is measured against (Phase 4, decided 2026-10-03): started in the last 30 days, and for
 * a repo-scoped item only that repo's sessions.
 */
export function scopeSessionsSql(item: InventoryRow): { where: string; params: unknown[] } {
	return item.scope === "repo"
		? { where: "s.started_at >= ? AND s.repo_id = ?", params: [item.repo_id] }
		: { where: "s.started_at >= ?", params: [] };
}

/** A usage row's non-cached tokens in SQL (costTokensOf): input, cache writes and output; `t` is a table prefix. */
export const costTokensSql = (t = ""): string => `${t}input_tokens + ${t}output_tokens + ${t}cache_creation_tokens`;

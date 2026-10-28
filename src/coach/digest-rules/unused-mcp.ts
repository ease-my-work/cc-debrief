// Digest rule 2, unused MCP server (feature 09; Phase 4 spec decision 5): configured, 0 calls in 30 days, costed by
// its tool schemas in every session that loaded it.
import type { Db } from "../../db/adapter";
import { parseToolName } from "../../derive/tools";
import { decodePayload } from "../../ingest/line";
import type { DigestRule, Finding } from "../types";
import { daysBefore, type InventoryRow, presentItems, scopeSessionsSql } from "./shared";

/** Tokens per tool schema (feature 09 placeholder, tuned in the dogfood week). */
export const SCHEMA_TOKENS = 150;
/** Schemas assumed when no tool listing names the server's tools. */
export const ESTIMATED_SCHEMAS = 10;
const MAX_LISTINGS = 5;

const sourceOf = (item: InventoryRow): string | null =>
	item.scope === "plugin" && typeof item.meta.plugin === "string" ? `plugin:${item.meta.plugin}` : null;

/**
 * Deferred tool names listed in a session's main transcript: `deferred_tools_delta` attachments applied in line
 * order (added, then removed). null when the session has no such attachment.
 */
export function listedTools(db: Db, sessionId: string): Set<string> | null {
	const rows = db
		.prepare(
			`SELECT l.payload FROM transcript_lines l
			 WHERE l.session_id = ? AND l.agent_id IS NULL AND l.type = 'attachment' AND l.subtype = 'deferred_tools_delta'
			 ORDER BY l.file_id, l.line_no`,
		)
		.all<{ payload: Uint8Array }>(sessionId);
	if (rows.length === 0) return null;
	const names = new Set<string>();
	for (const r of rows) {
		let a: Record<string, unknown> = {};
		try {
			const line = decodePayload(r.payload) as { attachment?: Record<string, unknown> };
			a = line.attachment ?? {};
		} catch {
			continue;
		}
		for (const n of Array.isArray(a.addedNames) ? a.addedNames : []) if (typeof n === "string") names.add(n);
		for (const n of Array.isArray(a.removedNames) ? a.removedNames : []) if (typeof n === "string") names.delete(n);
	}
	return names;
}

export const unusedMcp: DigestRule = {
	rule: "unused_mcp",
	run(db, now) {
		const since = daysBefore(now, 30);
		const out: Finding[] = [];
		for (const item of presentItems(db, "mcp")) {
			const source = sourceOf(item);
			const calls =
				db
					.prepare(
						`SELECT count(*) AS n FROM tool_calls
						 WHERE mcp_server = ? AND mcp_source IS ? AND started_at >= ?`,
					)
					.get<{ n: number }>(item.name, source, since)?.n ?? 0;
			if (calls > 0) continue;
			const scope = scopeSessionsSql(item);
			const loaded = db
				.prepare(
					`SELECT s.session_id FROM inventory_usage u JOIN sessions s ON s.session_id = u.session_id
					 WHERE u.inventory_id = ? AND u.loaded = 1 AND ${scope.where}
					 ORDER BY s.started_at DESC`,
				)
				.all<{ session_id: string }>(item.id, since, ...scope.params)
				.map((r) => r.session_id);
			// The newest loaded session with a tool listing that names this server's tools (at most 5 listings read).
			let schemas = 0;
			let listings = 0;
			for (const id of loaded) {
				if (listings >= MAX_LISTINGS) break;
				const tools = listedTools(db, id);
				if (!tools) continue;
				listings++;
				for (const name of tools) {
					const p = parseToolName(name, null);
					if (p.mcpServer === item.name && p.mcpSource === source) schemas++;
				}
				if (schemas > 0) break;
			}
			const estimated = schemas === 0;
			if (estimated) schemas = ESTIMATED_SCHEMAS;
			out.push({
				rule: this.rule,
				severity: "low",
				message: `MCP server \`${item.name}\` configured, 0 calls in 30 days · ${
					estimated ? `~${schemas} tool schemas (estimated)` : `${schemas} tool schemas`
				}`,
				evidence: {
					key: String(item.id),
					server: item.name,
					calls: 0,
					schemas,
					estimated,
					sessions: loaded.length,
					repoId: item.scope === "repo" ? item.repo_id : null,
				},
				costTokens: schemas * SCHEMA_TOKENS * loaded.length,
				target: "skills",
			});
		}
		return out;
	},
};

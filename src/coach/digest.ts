// Weekly coaching digest (feature 09): the five digest rules, recomputed on `dashboard` start as session-less
// findings, and buildDigest(), which groups and ranks every finding on each GET /api/improvements.
import { type Config, loadConfig } from "../config";
import type { Db } from "../db/adapter";
import { upsertFindings } from "../db/queries/findings";
import { digestFooter } from "../db/queries/improvements";
import { getMeta } from "../db/queries/meta";
import { rangeStart } from "../db/queries/range";
import { digestAction } from "../patterns/views";
import type { DigestItem, ImprovementsResponse, Range } from "../server/types";
import { budgetOver } from "./digest-rules/budget-over";
import { cacheHitDip } from "./digest-rules/cache-hit-dip";
import { modelMix } from "./digest-rules/model-mix";
import { spendSpike } from "./digest-rules/spend-spike";
import { toolFailureHotspot } from "./digest-rules/tool-failure-hotspot";
import { unusedMcp } from "./digest-rules/unused-mcp";
import { unusedSkill } from "./digest-rules/unused-skill";
import { ruleLabel } from "./labels";
import { logCoachError } from "./tier1";
import type { DigestRule, Finding, Severity } from "./types";

export type { DigestRule } from "./types";

/** Placeholder floor, tuned in the Phase 4 dogfood week; Phase 5b's pattern candidates use it. */
export const DIGEST_COST_FLOOR_TOKENS = 50_000;
/** Detection-owned findings (Phase 5b spec decision 6): one digest item each, never merged by repo. */
const PATTERN_RULES = new Set(["repeat_pattern", "test_gap", "skill_not_triggering"]);

export const DIGEST_RULES: DigestRule[] = [
	unusedSkill,
	unusedMcp,
	cacheHitDip,
	modelMix,
	toolFailureHotspot,
	spendSpike, // rule 5, Phase 7 P5
	budgetOver, // Phase 7 P4
];

const TOP_ITEMS = 3;
const SEVERITY_RANK: Record<Severity, number> = { low: 1, medium: 2, high: 3 };
const MCP_RULES = new Set(["unused_mcp", "mcp_bypassed"]);
/** Spend rules resolve on the Costs view (Phase 7 P4, P5). */
const COST_RULES = new Set(["budget_over", "spend_spike"]);

type Row = {
	id: number;
	session_id: string | null;
	rule: string;
	subject_key: string;
	repo_id: string | null;
	severity: Severity;
	message: string;
	cost_tokens: number;
	created_at: string;
	target: Finding["target"] | null;
	feedback: DigestItem["feedback"];
};

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The view that resolves an item (feature 09 `DigestItem.href`). */
function hrefFor(rule: string, target: Finding["target"], top: Row): string {
	if (COST_RULES.has(rule)) return "/costs";
	if (target === "skills") return `/skills?tab=${MCP_RULES.has(rule) ? "mcp" : "skills"}&unused=1`;
	if (target === "repos") return top.repo_id ? `/repos/${encodeURIComponent(top.repo_id)}` : "/repos";
	if (target === "session") {
		if (rule === "model_mix") return "/sessions?type=exploration";
		if (top.session_id) return `/sessions/${encodeURIComponent(top.session_id)}`;
	}
	return "/sessions?range=7d";
}

/**
 * The ranked digest (feature 09 "Building the digest"; Phase 4 spec decision 3): findings created in the range (and
 * repo), not dismissed, grouped by rule and repo; non-demoted rules first, then by summed cost, severity and the newest
 * finding; items with no cost are left out; the first three (opts.limit) are returned with the 7-day footer.
 */
export function buildDigest(
	db: Db,
	opts: { range: Range; repo?: string; now?: Date; cfg?: Config; limit?: number },
): ImprovementsResponse {
	const now = opts.now ?? new Date();
	const nowIso = now.toISOString();
	const cfg = opts.cfg ?? loadConfig();
	const rows = db
		.prepare(
			`SELECT f.id, f.session_id, f.rule, f.subject_key, f.repo_id, f.severity, f.message, f.cost_tokens, f.created_at,
			   f.feedback, json_extract(f.evidence, '$.target') AS target
			 FROM findings f
			 WHERE f.created_at >= ? AND (f.dismissed_until IS NULL OR f.dismissed_until <= ?)${opts.repo ? " AND f.repo_id = ?" : ""}`,
		)
		.all<Row>(rangeStart(opts.range, now), nowIso, ...(opts.repo ? [opts.repo] : []));
	const metaDismissed = new Map(
		db
			.prepare("SELECT key, value FROM meta WHERE key LIKE 'dismiss:%'")
			.all<{ key: string; value: string }>()
			.map((m) => [m.key, m.value]),
	);
	const demoted = new Set(
		db
			.prepare("SELECT rule FROM rule_feedback WHERE demoted = 1")
			.all<{ rule: string }>()
			.map((r) => r.rule),
	);
	const repoNames = new Map(
		db
			.prepare("SELECT repo_id, name FROM repos")
			.all<{ repo_id: string; name: string }>()
			.map((r) => [r.repo_id, r.name]),
	);

	type Group = { rows: Row[]; cost: number; severity: Severity; latest: string; sessions: Set<string>; top: Row };
	const groups = new Map<string, Group>();
	for (const r of rows) {
		if (r.session_id === null && (metaDismissed.get(dismissKey(r.rule, r.subject_key)) ?? "") > nowIso) continue;
		// A pattern finding is its own item: two repeated tasks in one repo are two suggestions (Phase 5b build).
		const key = PATTERN_RULES.has(r.rule) ? `${r.rule}\u0000${r.subject_key}` : `${r.rule}\u0000${r.repo_id ?? ""}`;
		const g = groups.get(key);
		if (!g) {
			groups.set(key, {
				rows: [r],
				cost: r.cost_tokens,
				severity: r.severity,
				latest: r.created_at,
				sessions: new Set(r.session_id ? [r.session_id] : []),
				top: r,
			});
			continue;
		}
		g.rows.push(r);
		g.cost += r.cost_tokens;
		if (SEVERITY_RANK[r.severity] > SEVERITY_RANK[g.severity]) g.severity = r.severity;
		if (r.created_at > g.latest) g.latest = r.created_at;
		if (r.session_id) g.sessions.add(r.session_id);
		if (r.cost_tokens > g.top.cost_tokens || (r.cost_tokens === g.top.cost_tokens && r.created_at > g.top.created_at)) {
			g.top = r;
		}
	}

	const items: DigestItem[] = [...groups.values()]
		.filter((g) => g.cost > 0)
		.sort(
			(a, b) =>
				Number(demoted.has(a.top.rule)) - Number(demoted.has(b.top.rule)) ||
				b.cost - a.cost ||
				SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
				b.latest.localeCompare(a.latest),
		)
		.slice(0, opts.limit ?? TOP_ITEMS)
		.map((g) => {
			const { top } = g;
			const label = capitalize(ruleLabel(top.rule));
			const repoName = top.repo_id ? repoNames.get(top.repo_id) : undefined;
			const message =
				g.rows.length === 1
					? top.message
					: g.sessions.size >= 2
						? `${label} in ${g.sessions.size} sessions${repoName ? ` in \`${repoName}\`` : ""}`
						: `${label} ×${g.rows.length}`;
			const target = top.target ?? "session";
			return {
				id: top.id,
				rule: top.rule,
				severity: g.severity,
				message,
				costTokens: g.cost,
				sessionCount: g.sessions.size,
				repoId: top.repo_id,
				target,
				href: hrefFor(top.rule, target, top),
				demoted: demoted.has(top.rule),
				collapsed: false,
				feedback: top.feedback,
				action: digestAction(db, cfg, top.subject_key, top.rule),
			};
		});
	return { items, footer: digestFooter(db, cfg, now) };
}

/** meta key that keeps a digest-rule finding dismissed across recomputes (Phase 4 spec decision 4). */
export const dismissKey = (rule: string, subject: string) => `dismiss:${rule}:${subject}`;

/**
 * Recomputes each digest rule: its session-less findings are replaced by what it produces now (created now), and a
 * finding whose `dismiss:<rule>:<subject>` meta date is in the future gets that `dismissed_until`. A rule that throws
 * is logged and keeps its previous rows. Returns the number of findings written.
 */
export function runDigestRules(db: Db, now: Date = new Date(), rules: DigestRule[] = DIGEST_RULES): number {
	let written = 0;
	for (const rule of rules) {
		let found: ReturnType<DigestRule["run"]>;
		try {
			found = rule.run(db, now);
		} catch (e) {
			logCoachError(e, rule.rule);
			continue;
		}
		db.transaction(() => {
			// Keyed upserts keep each subject's feedback across recomputes (review B3: a delete here reset votes on every
			// dashboard start, so one item could demote its rule over three restarts).
			upsertFindings(db, null, [rule.rule], found, now);
			const dismiss = db.prepare(
				"UPDATE findings SET dismissed_until = ? WHERE session_id IS NULL AND rule = ? AND subject_key = ?",
			);
			for (const f of found) {
				const subject = f.evidence.key == null ? "" : String(f.evidence.key);
				const until = getMeta(db, dismissKey(rule.rule, subject));
				// The meta key is the dismissal of a session-less subject: copied when in the future, cleared otherwise.
				dismiss.run(until && until > now.toISOString() ? until : null, rule.rule, subject);
			}
		});
		written += found.length;
	}
	return written;
}

// What the dashboard shows of patterns (features 10-12; Phase 5b spec decision 5): PatternRow lists with draft
// estimates, the Repos "Repeated work · suggestions" order, the Skills & Tools "Skills proposed from repeated work"
// rows with adoption, and the digest's inline draft action.
import type { Config } from "../config";
import type { Db } from "../db/adapter";
import { listPatternRows, type Pattern, type PatternStatus, toPatternRow } from "../db/queries/patterns";
import type { DigestItem, PatternRow, ProposedSkill } from "../server/types";
import { adoptionStats, NOT_TRIGGERING_RULE, sessionMedians } from "./adoption";
import { currentSkill } from "./context";
import { estimateDraftCost } from "./draft";

const SKILL_KINDS = new Set(["repo_skill", "user_skill"]);

/** The draft estimate a card or button shows: a skill create, a rule rewrite; null for kinds with no AI draft. */
export function draftEstimate(db: Db, p: Pattern, cfg: Config): number | null {
	if (SKILL_KINDS.has(p.kind)) return estimateDraftCost(db, p.id, cfg, p.status === "installed" ? "widen" : "create");
	if (p.kind === "claude_md_rule") return estimateDraftCost(db, p.id, cfg, "rewrite_rule");
	return null;
}

/** GET /api/patterns: rows by tokens, with estimates for candidates and drafted rows. */
export function patternRows(
	db: Db,
	cfg: Config,
	opts: { repo?: string | null; status?: PatternStatus } = {},
): PatternRow[] {
	return listPatternRows(db, opts).map((p) =>
		toPatternRow(p, p.status === "candidate" || p.status === "drafted" ? draftEstimate(db, p, cfg) : null),
	);
}

const ORDER: Record<string, number> = { candidate: 0, drafted: 1, installed: 2 };

/** Repos panel: candidates by tokens, then drafted, then installed, then test gaps; dismissed rows left out. */
export function repoSuggestions(db: Db, cfg: Config, repoId: string): PatternRow[] {
	return patternRows(db, cfg, { repo: repoId })
		.filter((p) => p.status !== "dismissed")
		.sort((a, b) => {
			const gap = Number(a.kind === "test_gap") - Number(b.kind === "test_gap");
			return gap || (ORDER[a.status] ?? 3) - (ORDER[b.status] ?? 3) || b.tokensTotal - a.tokensTotal || a.id - b.id;
		});
}

const pct = (before: number, after: number) => (before > 0 ? Math.round(((after - before) / before) * 100) : null);

/** Skills & Tools "Skills proposed from repeated work": candidate, drafted and installed skill patterns. */
export function proposedSkills(db: Db, cfg: Config, now: Date = new Date()): ProposedSkill[] {
	const repoNames = new Map(
		db
			.prepare("SELECT repo_id, name FROM repos")
			.all<{ repo_id: string; name: string }>()
			.map((r) => [r.repo_id, r.name]),
	);
	const notTriggering = new Set(
		db
			.prepare(`SELECT subject_key FROM findings WHERE rule = ? AND session_id IS NULL`)
			.all<{ subject_key: string }>(NOT_TRIGGERING_RULE)
			.map((r) => r.subject_key),
	);
	const order = (s: PatternStatus) => (s === "installed" ? 0 : s === "drafted" ? 1 : 2);
	return listPatternRows(db)
		.filter((p) => SKILL_KINDS.has(p.kind) && p.status !== "dismissed")
		.sort((a, b) => order(a.status) - order(b.status) || b.tokensTotal - a.tokensTotal)
		.map((p) => {
			const skill = currentSkill(db, p);
			const a = adoptionStats(db, p.id, now);
			// Not installed yet: "before" is every session of the pattern.
			const before = p.status === "installed" ? a.before : sessionMedians(db, p.sessionIds);
			const stuck = notTriggering.has(`pattern:${p.id}`);
			const action: ProposedSkill["action"] =
				p.status === "candidate" ? "draft" : p.status === "drafted" ? "review" : stuck ? "widen" : null;
			return {
				patternId: p.id,
				name: skill.name ?? p.label,
				description: skill.description,
				repo: p.repoId ? { id: p.repoId, name: repoNames.get(p.repoId) ?? p.repoId } : null,
				status: p.status as ProposedSkill["status"],
				installedDays: a.installedDays,
				invoked: a.invoked,
				medianTokens: before
					? {
							before: before.medianTokens,
							after: a.after?.medianTokens ?? null,
							pct: a.after ? pct(before.medianTokens, a.after.medianTokens) : null,
						}
					: null,
				medianDurationSec:
					before?.medianDurationSec != null
						? { before: before.medianDurationSec, after: a.after?.medianDurationSec ?? null }
						: null,
				action,
				estUsd: action === "draft" || action === "widen" ? draftEstimate(db, p, cfg) : null,
				removed: a.removed,
				sessionCount: p.sessionIds.length,
				sessionsSinceInstall: p.status === "installed" ? a.sessionsAfter : null,
			};
		});
}

/** The digest item's inline "Draft skill (~$)" for a repeat_pattern item whose pattern is a skill candidate. */
export function digestAction(db: Db, cfg: Config, subjectKey: string, rule: string): DigestItem["action"] {
	if (rule !== "repeat_pattern") return null;
	const id = Number(/^pattern:(\d+)$/.exec(subjectKey)?.[1]);
	if (!Number.isSafeInteger(id)) return null;
	const p = listPatternRows(db).find((x) => x.id === id);
	if (!p || !SKILL_KINDS.has(p.kind) || p.status !== "candidate") return null;
	return { kind: "draft", patternId: id, estUsd: draftEstimate(db, p, cfg) };
}

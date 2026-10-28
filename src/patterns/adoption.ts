// Closing the loop (feature 11 "Closing the loop"; Phase 5b spec decision 7): for an installed skill pattern, how often
// the skill was invoked since install, the median tokens and duration of matching sessions before and after install,
// whether the skill was removed, and the "skill not triggering" finding.
import { costTokensSql } from "../coach/digest-rules/shared";
import type { Finding } from "../coach/types";
import type { Db } from "../db/adapter";
import { upsertFindings } from "../db/queries/findings";
import { getMeta } from "../db/queries/meta";
import { getPattern, listPatternRows, type Pattern } from "../db/queries/patterns";

const DAY_MS = 86_400_000;
const NOT_TRIGGERING_DAYS = 14;
const MIN_AFTER = 2;
export const NOT_TRIGGERING_RULE = "skill_not_triggering";

export type Medians = { medianTokens: number; medianDurationSec: number | null; n: number };
export type Adoption = {
	/** Calls of the skill in sessions started after install; null without a linked skill row. */
	invoked: number | null;
	before: Medians | null;
	/** Only once ≥ 2 matching sessions started after install. */
	after: Medians | null;
	installedDays: number | null;
	/** The linked skill row was not found by the latest scan (or is gone). */
	removed: boolean;
	skillName: string | null;
	/** Matching sessions started after install. */
	sessionsAfter: number;
};

const median = (xs: number[]): number | null => {
	if (xs.length === 0) return null;
	const s = [...xs].sort((a, b) => a - b);
	const m = Math.floor(s.length / 2);
	return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
};

type SessionStat = { id: string; startedAt: string; tokens: number; durationSec: number | null };

function sessionStats(db: Db, ids: string[]): SessionStat[] {
	if (ids.length === 0) return [];
	return db
		.prepare(
			`SELECT s.session_id, s.started_at, s.ended_at,
			   (SELECT coalesce(sum(${costTokensSql("u.")}), 0) FROM usage u WHERE u.session_id = s.session_id) AS tokens
			 FROM sessions s WHERE s.session_id IN (${ids.map(() => "?").join(", ")})`,
		)
		.all<{ session_id: string; started_at: string; ended_at: string | null; tokens: number }>(...ids)
		.map((r) => ({
			id: r.session_id,
			startedAt: r.started_at,
			tokens: r.tokens,
			durationSec: r.ended_at
				? Math.max(0, Math.round((Date.parse(r.ended_at) - Date.parse(r.started_at)) / 1000))
				: null,
		}));
}

/** Medians over the given sessions (a candidate's "before": every session of the pattern). */
export function sessionMedians(db: Db, ids: string[]): Medians | null {
	return medians(sessionStats(db, ids));
}

function medians(ss: SessionStat[]): Medians | null {
	if (ss.length === 0) return null;
	return {
		medianTokens: median(ss.map((s) => s.tokens)) as number,
		medianDurationSec: median(ss.map((s) => s.durationSec).filter((d): d is number => d !== null)),
		n: ss.length,
	};
}

function skillRow(db: Db, p: Pattern): { name: string; lastSeen: string; scope: string; repoId: string | null } | null {
	if (p.inventoryId === null) return null;
	const r = db
		.prepare("SELECT name, last_seen, scope, repo_id FROM inventory WHERE id = ?")
		.get<{ name: string; last_seen: string; scope: string; repo_id: string | null }>(p.inventoryId);
	return r ? { name: r.name, lastSeen: r.last_seen, scope: r.scope, repoId: r.repo_id } : null;
}

/** Feature 11 adoption numbers for one pattern (all null-ish before install). */
export function adoptionStats(db: Db, patternId: number, now: Date = new Date()): Adoption {
	const p = getPattern(db, patternId);
	const empty: Adoption = {
		invoked: null,
		before: null,
		after: null,
		installedDays: null,
		removed: false,
		skillName: null,
		sessionsAfter: 0,
	};
	if (p?.status !== "installed" || !p.installedAt) return empty;
	const at = p.installedAt;
	const stats = sessionStats(db, p.sessionIds);
	const after = stats.filter((s) => s.startedAt >= at);
	const skill = skillRow(db, p);
	let invoked: number | null = null;
	let removed = p.kind === "repo_skill" || p.kind === "user_skill" ? skill === null : false;
	if (skill) {
		invoked =
			db
				.prepare(
					`SELECT count(*) AS n FROM tool_calls c JOIN sessions s ON s.session_id = c.session_id
					 WHERE c.skill_name = ? AND s.started_at >= ?${skill.scope === "repo" ? " AND s.repo_id = ?" : ""}`,
				)
				.get<{ n: number }>(skill.name, at, ...(skill.scope === "repo" ? [skill.repoId] : []))?.n ?? 0;
		// A scan after the skill's last sighting means the scan no longer found it.
		const scan = getMeta(
			db,
			skill.scope === "repo" && skill.repoId ? `last_scan_repo:${skill.repoId}` : "last_scan_user",
		);
		removed = scan !== null && skill.lastSeen < scan;
	}
	return {
		invoked,
		before: medians(stats.filter((s) => s.startedAt < at)),
		after: after.length >= MIN_AFTER ? medians(after) : null,
		installedDays: Math.max(0, Math.floor((now.getTime() - Date.parse(at)) / DAY_MS)),
		removed,
		skillName: skill?.name ?? null,
		sessionsAfter: after.length,
	};
}

/**
 * "Skill not triggering" (feature 11): an installed skill pattern 14+ days old with 0 invocations and ≥ 1 matching
 * session since install gets a session-less finding (subject `pattern:<id>`, target skills); one that no longer
 * qualifies loses it. Runs on dashboard start after detection. Returns how many are flagged.
 */
export function checkInstalledPatterns(db: Db, now: Date = new Date()): number {
	const findings: Finding[] = [];
	for (const p of listPatternRows(db, { status: "installed" })) {
		if (p.kind !== "repo_skill" && p.kind !== "user_skill") continue;
		const a = adoptionStats(db, p.id, now);
		if (a.removed || a.invoked !== 0 || (a.installedDays ?? 0) < NOT_TRIGGERING_DAYS || a.sessionsAfter < 1) continue;
		const afterTokens = sessionStats(db, p.sessionIds)
			.filter((s) => s.startedAt >= (p.installedAt as string))
			.reduce((n, s) => n + s.tokens, 0);
		findings.push({
			rule: NOT_TRIGGERING_RULE,
			severity: "low",
			message: `\`${a.skillName ?? p.label}\` skill not triggering — description too narrow: 0 invocations in ${a.installedDays} days while the task came back ${a.sessionsAfter} ${a.sessionsAfter === 1 ? "time" : "times"}`,
			evidence: {
				key: `pattern:${p.id}`,
				patternId: p.id,
				repoId: p.repoId,
				skill: a.skillName,
				days: a.installedDays,
			},
			costTokens: afterTokens,
			target: "skills",
		});
	}
	upsertFindings(db, null, [NOT_TRIGGERING_RULE], findings, now);
	return findings.length;
}

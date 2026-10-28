// Helpful / not-helpful, dismiss and demotion (feature 09 "Feedback and demotion", "Dismiss"; Phase 4 spec
// decisions 3 and 4). Every action applies to the finding's whole digest group.
import type { Db } from "../db/adapter";
import { findingGroup } from "../db/queries/findings";
import { setMeta } from "../db/queries/meta";
import { setReviewFeedback } from "../db/queries/reviews";
import { addRuleVotes, getRuleFeedback, resetRule } from "../db/queries/ruleFeedback";
import { dismissKey } from "./digest";
import { TIER2_RULES } from "./review";

export class UnknownFindingError extends Error {
	constructor(id: number) {
		super(`no finding ${id}`);
	}
}

const DAY_MS = 86_400_000;
type Value = "helpful" | "not_helpful";

function findingRule(db: Db, id: number): string {
	const f = db.prepare("SELECT rule FROM findings WHERE id = ?").get<{ rule: string }>(id);
	if (!f) throw new UnknownFindingError(id);
	return f.rule;
}

const placeholders = (ids: number[]) => ids.map(() => "?").join(", ");

/**
 * Sets `feedback` on every finding of the group and counts one vote for the action: +1 to the value's counter, and −1
 * from the other counter when the group had that vote before; an action that changes nothing counts 0. A rule
 * demotes at three not-helpful votes since its last re-enable. Throws UnknownFindingError.
 */
export function recordFeedback(db: Db, findingId: number, value: Value, now: Date = new Date()): { demoted: boolean } {
	return db.transaction(() => {
		const rule = findingRule(db, findingId);
		const ids = findingGroup(db, findingId, now);
		const before = db
			.prepare(`SELECT feedback FROM findings WHERE id IN (${placeholders(ids)})`)
			.all<{ feedback: Value | null }>(...ids)
			.map((r) => r.feedback);
		if (before.every((f) => f === value)) return { demoted: isDemoted(db, rule) };
		const other: Value = value === "helpful" ? "not_helpful" : "helpful";
		const switched = before.includes(other) ? -1 : 0;
		db.prepare(`UPDATE findings SET feedback = ? WHERE id IN (${placeholders(ids)})`).run(value, ...ids);
		const votes = value === "helpful" ? { helpful: 1, notHelpful: switched } : { helpful: switched, notHelpful: 1 };
		return { demoted: addRuleVotes(db, rule, votes, now).demoted };
	});
}

/**
 * Dismisses the finding's group for `days` (default 30) and writes `dismiss:<rule>:<subject>` meta keys for its
 * session-less members, which digest-rule recomputes read. Returns `dismissed_until`. Throws UnknownFindingError.
 */
export function dismissFinding(db: Db, findingId: number, days = 30, now: Date = new Date()): string {
	return db.transaction(() => {
		findingRule(db, findingId);
		const until = new Date(now.getTime() + days * DAY_MS).toISOString();
		const ids = findingGroup(db, findingId, now);
		db.prepare(`UPDATE findings SET dismissed_until = ? WHERE id IN (${placeholders(ids)})`).run(until, ...ids);
		for (const r of db
			.prepare(`SELECT rule, subject_key FROM findings WHERE session_id IS NULL AND id IN (${placeholders(ids)})`)
			.all<{ rule: string; subject_key: string }>(...ids)) {
			setMeta(db, dismissKey(r.rule, r.subject_key), until);
		}
		return until;
	});
}

/**
 * The review band's "Dismiss 30d": dismisses every not-yet-dismissed finding of the finding's session (or the finding
 * itself when it has no session). Returns `dismissed_until`. Throws UnknownFindingError.
 */
export function dismissSessionFindings(db: Db, findingId: number, days = 30, now: Date = new Date()): string {
	return db.transaction(() => {
		const f = db.prepare("SELECT session_id FROM findings WHERE id = ?").get<{ session_id: string | null }>(findingId);
		if (!f) throw new UnknownFindingError(findingId);
		if (f.session_id === null) return dismissFinding(db, findingId, days, now);
		const until = new Date(now.getTime() + days * DAY_MS).toISOString();
		db.prepare(
			"UPDATE findings SET dismissed_until = ? WHERE session_id = ? AND (dismissed_until IS NULL OR dismissed_until <= ?)",
		).run(until, f.session_id, now.toISOString());
		return until;
	});
}

/** Re-enables a demoted rule from Settings: counters reset, normal rank restored. */
export function enableRule(db: Db, rule: string, now: Date = new Date()): void {
	resetRule(db, rule, now);
}

/** Whether the rule is demoted (ranked last in the digest; no auto-review trigger in Phase 5a). */
export function isDemoted(db: Db, rule: string): boolean {
	return getRuleFeedback(db, rule)?.demoted ?? false;
}

/**
 * "Was this useful?" on a Tier 2 review (Phase 5a spec decision 3): the value goes on every Tier 2 finding of the
 * session and counts as one action per rule, with the recordFeedback() vote rules (switching counts −1 from the other
 * counter; repeating counts 0). The value is stored on the review even when it produced no findings. Returns the rules
 * that are demoted afterwards. Throws UnknownFindingError when the session has no review.
 */
export function recordReviewFeedback(db: Db, sessionId: string, value: Value, now: Date = new Date()): string[] {
	return db.transaction(() => {
		if (!db.prepare("SELECT 1 AS x FROM reviews WHERE session_id = ?").get(sessionId)) {
			throw new UnknownFindingError(-1);
		}
		const demoted: string[] = [];
		for (const rule of TIER2_RULES) {
			const before = db
				.prepare("SELECT feedback FROM findings WHERE session_id = ? AND rule = ?")
				.all<{ feedback: Value | null }>(sessionId, rule)
				.map((r) => r.feedback);
			if (before.length === 0) continue;
			if (before.every((f) => f === value)) {
				if (isDemoted(db, rule)) demoted.push(rule);
				continue;
			}
			const other: Value = value === "helpful" ? "not_helpful" : "helpful";
			const switched = before.includes(other) ? -1 : 0;
			db.prepare("UPDATE findings SET feedback = ? WHERE session_id = ? AND rule = ?").run(value, sessionId, rule);
			const votes = value === "helpful" ? { helpful: 1, notHelpful: switched } : { helpful: switched, notHelpful: 1 };
			if (addRuleVotes(db, rule, votes, now).demoted) demoted.push(rule);
		}
		setReviewFeedback(db, sessionId, value);
		return demoted;
	});
}

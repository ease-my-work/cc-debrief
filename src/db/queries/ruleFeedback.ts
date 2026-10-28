// Per-rule helpful / not-helpful counters and demotion (feature 09 "Feedback and demotion").
import type { Db } from "../adapter";

/** Not-helpful votes since the last re-enable that demote a rule (feature 09). */
export const DEMOTE_AFTER = 3;

export type RuleFeedback = { rule: string; helpful: number; notHelpful: number; demoted: boolean; updatedAt: string };

type Row = { rule: string; helpful: number; not_helpful: number; demoted: number; updated_at: string };
const toRuleFeedback = (r: Row): RuleFeedback => ({
	rule: r.rule,
	helpful: r.helpful,
	notHelpful: r.not_helpful,
	demoted: r.demoted === 1,
	updatedAt: r.updated_at,
});

export function getRuleFeedback(db: Db, rule: string): RuleFeedback | null {
	const r = db
		.prepare("SELECT rule, helpful, not_helpful, demoted, updated_at FROM rule_feedback WHERE rule = ?")
		.get<Row>(rule);
	return r ? toRuleFeedback(r) : null;
}

/**
 * Adds one action's vote deltas (each -1, 0 or +1; counters never drop below 0) and demotes the rule once
 * `not_helpful` reaches DEMOTE_AFTER. Returns the updated row.
 */
export function addRuleVotes(
	db: Db,
	rule: string,
	delta: { helpful: number; notHelpful: number },
	now: Date = new Date(),
): RuleFeedback {
	db.prepare(
		`INSERT INTO rule_feedback (rule, helpful, not_helpful, demoted, updated_at) VALUES (?, 0, 0, 0, ?)
		 ON CONFLICT (rule) DO NOTHING`,
	).run(rule, now.toISOString());
	db.prepare(
		`UPDATE rule_feedback SET helpful = max(0, helpful + ?), not_helpful = max(0, not_helpful + ?), updated_at = ?
		 WHERE rule = ?`,
	).run(delta.helpful, delta.notHelpful, now.toISOString(), rule);
	db.prepare("UPDATE rule_feedback SET demoted = 1 WHERE rule = ? AND demoted = 0 AND not_helpful >= ?").run(
		rule,
		DEMOTE_AFTER,
	);
	return getRuleFeedback(db, rule) as RuleFeedback;
}

/** Re-enables a rule: demoted = 0 and both counters reset. A rule with no row is left without one. */
export function resetRule(db: Db, rule: string, now: Date = new Date()): void {
	db.prepare("UPDATE rule_feedback SET helpful = 0, not_helpful = 0, demoted = 0, updated_at = ? WHERE rule = ?").run(
		now.toISOString(),
		rule,
	);
}

/** Demoted rules for Settings, by rule id; `demotedAt` is the row's last update. */
export function listDemotedRules(db: Db): { rule: string; notHelpful: number; demotedAt: string }[] {
	return db
		.prepare("SELECT rule, not_helpful, updated_at FROM rule_feedback WHERE demoted = 1 ORDER BY rule")
		.all<{ rule: string; not_helpful: number; updated_at: string }>()
		.map((r) => ({ rule: r.rule, notHelpful: r.not_helpful, demotedAt: r.updated_at }));
}

// The findings table (features 07, 09; Phase 4 spec decisions 2-4): keyed upserts that keep dismissals and feedback,
// digest groups and the FindingRow list behind GET /api/findings.
import { ruleLabel } from "../../coach/labels";
import type { Finding } from "../../coach/types";
import type { Config } from "../../config";
import type { FindingRow, Range, ReviewBand } from "../../server/types";
import type { Db } from "../adapter";
import { nudgeDismissed } from "./improvements";
import { rangeStart } from "./range";

/** `subject_key` of a finding: its `evidence.key`, '' when none. */
export const subjectKey = (f: Finding): string => (f.evidence.key == null ? "" : String(f.evidence.key));

/**
 * Writes one producer's findings for a session (`null` = session-less digest findings). For each rule in `rules`:
 * produced findings are inserted or updated by (session, rule, subject_key), keeping `dismissed_until` and `feedback`;
 * the session's rows of that rule that were not produced are deleted unless they carry feedback. `created_at` is the
 * finding's `at`, else the session's last activity (ended_at, else started_at), else `now`. `repo_id` is the
 * session's repo, or `evidence.repoId` for session-less findings.
 */
export function upsertFindings(
	db: Db,
	sessionId: string | null,
	rules: string[],
	findings: Finding[],
	now: Date = new Date(),
): void {
	const s =
		sessionId === null
			? undefined
			: db
					.prepare("SELECT repo_id, coalesce(ended_at, started_at) AS at FROM sessions WHERE session_id = ?")
					.get<{ repo_id: string | null; at: string | null }>(sessionId);
	const sessionRepo = s?.repo_id ?? null;
	// When the finding happened (review B1): the session's last activity, or the digest finding's own `at`, else now.
	// Tier 1 running today on imported history must not date that history this week.
	const dateOf = (f: Finding) => f.at ?? s?.at ?? now.toISOString();
	const sessionKey = sessionId ?? "";
	const find = db.prepare(
		"SELECT id FROM findings WHERE COALESCE(session_id, '') = ? AND rule = ? AND subject_key = ?",
	);
	const update = db.prepare(
		"UPDATE findings SET repo_id = ?, severity = ?, message = ?, evidence = ?, cost_tokens = ?, created_at = ? WHERE id = ?",
	);
	const insert = db.prepare(
		`INSERT INTO findings (session_id, rule, subject_key, repo_id, severity, message, evidence, cost_tokens, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	db.transaction(() => {
		const kept = new Set<number>();
		for (const f of findings) {
			const key = subjectKey(f);
			const repo = sessionId === null ? ((f.evidence.repoId as string | null | undefined) ?? null) : sessionRepo;
			const evidence = JSON.stringify({ ...f.evidence, target: f.target });
			const cost = Math.max(0, Math.round(Number.isFinite(f.costTokens) ? f.costTokens : 0));
			const existing = find.get<{ id: number }>(sessionKey, f.rule, key);
			if (existing) {
				update.run(repo, f.severity, f.message, evidence, cost, dateOf(f), existing.id);
				kept.add(existing.id);
			} else {
				const r = insert.run(sessionId, f.rule, key, repo, f.severity, f.message, evidence, cost, dateOf(f));
				kept.add(Number(r.lastInsertRowid));
			}
		}
		const stale = db.prepare(
			"SELECT id FROM findings WHERE COALESCE(session_id, '') = ? AND rule = ? AND feedback IS NULL",
		);
		const del = db.prepare("DELETE FROM findings WHERE id = ?");
		for (const rule of rules) {
			for (const { id } of stale.all<{ id: number }>(sessionKey, rule)) if (!kept.has(id)) del.run(id);
		}
	});
}

/**
 * Ids of the finding's digest group (spec decision 3): same rule and repo_id (NULL with NULL), created within 30 days
 * of it, not dismissed at `now`. The finding itself is always included; [] for an unknown id.
 */
export function findingGroup(db: Db, findingId: number, now: Date = new Date()): number[] {
	return db
		.prepare(
			`SELECT g.id FROM findings f
			 JOIN findings g ON g.rule = f.rule AND g.repo_id IS f.repo_id
			   AND g.created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', f.created_at, '-30 days')
			   AND g.created_at <= strftime('%Y-%m-%dT%H:%M:%fZ', f.created_at, '+30 days')
			   AND (g.id = f.id OR g.dismissed_until IS NULL OR g.dismissed_until <= ?)
			 WHERE f.id = ?
			 ORDER BY g.id`,
		)
		.all<{ id: number }>(now.toISOString(), findingId)
		.map((r) => r.id);
}

type Row = {
	id: number;
	session_id: string | null;
	rule: string;
	severity: FindingRow["severity"];
	message: string;
	evidence: string;
	cost_tokens: number;
	created_at: string;
	dismissed_until: string | null;
	feedback: FindingRow["feedback"];
	demoted: number | null;
	repo_id: string | null;
};

export const toFindingRow = (r: Row): FindingRow => ({
	id: r.id,
	sessionId: r.session_id,
	rule: r.rule,
	label: ruleLabel(r.rule),
	severity: r.severity,
	message: r.message,
	evidence: JSON.parse(r.evidence) as Record<string, unknown>,
	costTokens: r.cost_tokens,
	createdAt: r.created_at,
	dismissedUntil: r.dismissed_until,
	feedback: r.feedback,
	demoted: r.demoted === 1,
	repoId: r.repo_id,
});

export const FINDING_COLUMNS = `f.id, f.session_id, f.rule, f.severity, f.message, f.evidence, f.cost_tokens, f.created_at,
	f.dismissed_until, f.feedback, rf.demoted, f.repo_id`;

/** Findings newest first, dismissed ones included. `range` filters on created_at; omitted = all time. */
export function listFindings(
	db: Db,
	opts: { range?: Range; repo?: string; session?: string; now?: Date },
): FindingRow[] {
	const now = opts.now ?? new Date();
	const where: string[] = [];
	const params: unknown[] = [];
	if (opts.range) {
		where.push("f.created_at >= ?");
		params.push(rangeStart(opts.range, now));
	}
	if (opts.repo) {
		where.push("f.repo_id = ?");
		params.push(opts.repo);
	}
	if (opts.session) {
		where.push("f.session_id = ?");
		params.push(opts.session);
	}
	return db
		.prepare(
			`SELECT ${FINDING_COLUMNS} FROM findings f LEFT JOIN rule_feedback rf ON rf.rule = f.rule
			 ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
			 ORDER BY f.created_at DESC, f.id DESC`,
		)
		.all<Row>(...params)
		.map(toFindingRow);
}

/** Turn numbers a finding quotes: `evidence.turns`, else `firstTurn` / `lastTurn`. */
function evidenceTurns(e: Record<string, unknown>): number[] {
	if (Array.isArray(e.turns)) return e.turns.filter((t): t is number => typeof t === "number");
	const ends = [e.firstTurn, e.lastTurn].filter((t): t is number => typeof t === "number");
	return [...new Set(ends)];
}

/**
 * The Session review band (feature 12; Phase 4 spec decision 7): the session's non-dismissed findings by cost,
 * the latest active dismissal, the permission-prompt state, and the band nudge; a low-confidence Tier 2 finding is
 * collapsed. The review fields (state, estimate, cap, tier2) are filled in by sessionReviewBand() (Phase 5a).
 */
export function reviewBand(db: Db, sessionId: string, cfg: Config, now: Date = new Date()): ReviewBand {
	const nowIso = now.toISOString();
	const s = db.prepare("SELECT capture FROM sessions WHERE session_id = ?").get<{ capture: string }>(sessionId);
	const rows = db
		.prepare(
			`SELECT id, rule, severity, message, evidence, cost_tokens, feedback FROM findings
			 WHERE session_id = ? AND (dismissed_until IS NULL OR dismissed_until <= ?)
			 ORDER BY cost_tokens DESC, id`,
		)
		.all<{
			id: number;
			rule: string;
			severity: ReviewBand["findings"][number]["severity"];
			message: string;
			evidence: string;
			cost_tokens: number;
			feedback: ReviewBand["findings"][number]["feedback"];
		}>(sessionId, nowIso);
	const dismissedUntil =
		db
			.prepare("SELECT max(dismissed_until) AS d FROM findings WHERE session_id = ? AND dismissed_until > ?")
			.get<{ d: string | null }>(sessionId, nowIso)?.d ?? null;
	return {
		state: cfg.ai.review.enabled ? "not_reviewed" : "disabled",
		estUsd: null,
		capReached: false,
		findings: rows.map((r) => {
			const evidence = JSON.parse(r.evidence) as Record<string, unknown>;
			return {
				id: r.id,
				rule: r.rule,
				label: ruleLabel(r.rule),
				severity: r.severity,
				message: r.message,
				turns: evidenceTurns(evidence),
				costTokens: r.cost_tokens,
				// feature 08: findings of a confidence-low review render collapsed
				collapsed: evidence.confidence === "low",
				feedback: r.feedback,
			};
		}),
		tier2: null,
		dismissedUntil,
		permissionPrompts: s?.capture === "backfill" ? "not_recorded" : "recorded",
		nudgeDismissed: nudgeDismissed(db, "session"),
	};
}

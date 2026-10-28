// Tier 2 session review (feature 08; Phase 5a spec): the review schema, the fixed prompt built from Tier 1 evidence,
// the summary, the repo's task labels and the stored turns, and the cost estimate.
import { z } from "zod";
import { ClaudeError, type ClaudeResult, runClaude } from "../claude/headless";
import { estimateCost } from "../collector/prices";
import { buildStoredTurnsPrompt, priceableModel } from "../collector/summarize";
import type { Config } from "../config";
import type { Db } from "../db/adapter";
import { upsertFindings } from "../db/queries/findings";
import { reviewCostPer1kContext, upsertReview } from "../db/queries/reviews";
import { aiCallsToday } from "../db/queries/selfUsage";
import { withSessionLock } from "../locks";
import { normalizeLabel } from "../patterns/labels";
import { redactDeep } from "../redact";
import { loadSessionContext } from "./context";
import { costTokensSql } from "./digest-rules/shared";
import type { Finding, SessionContext } from "./types";

export const REVIEW_SCHEMA_VERSION = 1;
/** Tier 2 rules: never passed back into the prompt as Tier 1 evidence. */
export const TIER2_RULES = ["goal_drift", "review_friction"];

export const FRICTION_KINDS = [
	"ambiguous_ask",
	"missing_context",
	"scope_creep",
	"wrong_tool",
	"agent_confusion",
] as const;
export const CONFIDENCES = ["low", "medium", "high"] as const;

// Over-long text is cut, not rejected: a rejection spends a review with no retry.
const text = (max: number) => z.string().transform((s) => s.trim().slice(0, max));
const turn = z.number().int().min(1);

/** What a review call must return (feature 08 "Review schema"). Extra keys are dropped. */
export const ReviewResultSchema = z.object({
	goals: z.array(text(300)).transform((g) => g.filter(Boolean).slice(0, 10)),
	goal_changes: z.array(z.object({ turn, from: text(300), to: text(300) })).transform((c) => c.slice(0, 10)),
	friction: z.array(z.object({ turn, kind: z.enum(FRICTION_KINDS), note: text(500) })).transform((f) => f.slice(0, 20)),
	what_went_well: text(1000),
	better_approach: text(1500),
	suggested_first_prompt: text(2000),
	task_pattern: text(80),
	confidence: z.enum(CONFIDENCES),
});
export type ReviewResult = z.output<typeof ReviewResultSchema>;

const turnSchema = { type: "integer", minimum: 1 };
/** The JSON Schema passed to `claude -p --json-schema` (schema_version 1). */
export const REVIEW_SCHEMA = {
	type: "object",
	properties: {
		goals: { type: "array", items: { type: "string" }, description: "the distinct goals the developer pursued" },
		goal_changes: {
			type: "array",
			items: {
				type: "object",
				properties: { turn: turnSchema, from: { type: "string" }, to: { type: "string" } },
				required: ["turn", "from", "to"],
				additionalProperties: false,
			},
		},
		friction: {
			type: "array",
			items: {
				type: "object",
				properties: { turn: turnSchema, kind: { type: "string", enum: [...FRICTION_KINDS] }, note: { type: "string" } },
				required: ["turn", "kind", "note"],
				additionalProperties: false,
			},
		},
		what_went_well: { type: "string" },
		better_approach: { type: "string", description: "2-3 sentences, concrete" },
		suggested_first_prompt: { type: "string" },
		task_pattern: {
			type: "string",
			description: "short canonical label, reused from the repo's existing labels when one fits",
		},
		confidence: { type: "string", enum: [...CONFIDENCES] },
	},
	required: [
		"goals",
		"goal_changes",
		"friction",
		"what_went_well",
		"better_approach",
		"suggested_first_prompt",
		"task_pattern",
		"confidence",
	],
	additionalProperties: false,
} as const;

/**
 * Distinct `task_pattern` values of earlier reviews of sessions in the repo, most recently used first (Phase 5a spec
 * decision 1; Phase 5b adds `patterns.label`). [] for a session without a repo.
 */
export function repoTaskLabels(db: Db, repoId: string | null, limit = 30): string[] {
	if (repoId === null) return [];
	const reviewed = db
		.prepare(
			`SELECT json_extract(r.result, '$.task_pattern') AS label FROM reviews r
			 JOIN sessions s ON s.session_id = r.session_id
			 WHERE s.repo_id = ? AND trim(coalesce(json_extract(r.result, '$.task_pattern'), '')) <> ''
			 GROUP BY label ORDER BY max(r.created_at) DESC, label LIMIT ?`,
		)
		.all<{ label: string }>(repoId, limit)
		.map((r) => r.label);
	// Phase 5b: the repo's skill pattern labels (not fingerprint-only ones), after the reviews', same tasks once.
	const patterns = db
		.prepare(
			`SELECT label FROM patterns WHERE repo_id = ? AND kind = 'repo_skill' AND label_norm NOT LIKE 'fp:%'
			 ORDER BY last_seen DESC, id`,
		)
		.all<{ label: string }>(repoId)
		.map((r) => r.label);
	const out: string[] = [];
	const seen = new Set<string>();
	for (const label of [...reviewed, ...patterns]) {
		const key = normalizeLabel(label) || label.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(label);
	}
	return out.slice(0, limit);
}

type FindingEvidenceRow = { rule: string; message: string; evidence: string };

function tier1Findings(db: Db, sessionId: string): FindingEvidenceRow[] {
	return db
		.prepare(
			`SELECT rule, message, evidence FROM findings
			 WHERE session_id = ? AND rule NOT IN (${TIER2_RULES.map(() => "?").join(", ")})
			 ORDER BY cost_tokens DESC, id`,
		)
		.all<FindingEvidenceRow>(sessionId, ...TIER2_RULES);
}

/**
 * The fixed review prompt (runClaude() adds the `[cc-debrief:review]` sentinel line): instructions, the session's
 * Tier 1 findings with their evidence, the AI summary when present, the repo's task labels, and the condensed session
 * from the stored turns (≤ 60,000 chars). There is no resume mode (review 2026-10-10).
 */
export function buildReviewPrompt(db: Db, sessionId: string): string {
	const s = db
		.prepare("SELECT repo_id, summary, type_source FROM sessions WHERE session_id = ?")
		.get<{ repo_id: string | null; summary: string | null; type_source: string | null }>(sessionId);
	const findings = tier1Findings(db, sessionId);
	const labels = repoTaskLabels(db, s?.repo_id ?? null);
	const parts = [
		[
			"Review the condensed transcript at the end: a Claude Code session, as a coach for the developer who ran it.",
			"Only review what happened; do not continue the work.",
			"Reply with the JSON object the schema describes:",
			"- goals: each distinct goal the developer pursued, in order.",
			"- goal_changes: each turn where the developer switched to a different goal (turn numbers are the transcript's Turn numbers).",
			"- friction: turns where the ask was ambiguous, context was missing, scope crept, a wrong tool was used or the agent got confused.",
			"- what_went_well, better_approach (2-3 concrete sentences), suggested_first_prompt (a prompt that would have done the main goal better).",
			"- task_pattern: a short canonical label for the kind of task; reuse a label from the list below when one fits.",
			"- confidence: low when the session gives little to go on.",
			"Cite turn numbers, files and commands. No generic advice: every point must follow from this session.",
			"Use the Tier 1 findings below as measured evidence. Never repeat secrets, tokens, passwords or keys.",
		].join("\n"),
		[
			"## Tier 1 findings",
			findings.length === 0
				? "none"
				: findings.map((f) => `- ${f.rule}: ${f.message} ${compactEvidence(f.evidence)}`).join("\n"),
		].join("\n"),
	];
	if (s?.type_source === "ai" && s.summary?.trim()) parts.push(`## Summary\n${s.summary.trim()}`);
	parts.push(
		[
			"## Existing task labels for this repo",
			labels.length === 0 ? "none" : labels.map((l) => `- ${l}`).join("\n"),
		].join("\n"),
	);
	parts.push(`## Session\n${buildStoredTurnsPrompt(db, sessionId)}`);
	return parts.join("\n\n");
}

/** Evidence as compact JSON without the internal `target` key. */
function compactEvidence(evidence: string): string {
	try {
		const { target: _target, ...rest } = JSON.parse(evidence) as Record<string, unknown>;
		return JSON.stringify(rest);
	} catch {
		return evidence;
	}
}

// ---- Estimate ----

const OUTPUT_TOKENS = 1500;

/**
 * Estimated cost of reviewing the session (feature 08 step 3). Context = ceil(chars / 4) of the prompt
 * buildReviewPrompt() would send. With 5+ past review calls: context / 1000 × their median cost per 1k context;
 * otherwise the price table for ai.model (else the session's last model), context as uncached input plus 1,500 output
 * tokens. Null when no model is known or the model is not in the price table.
 */
export function estimateReviewCost(db: Db, sessionId: string, cfg: Config): number | null {
	const ctx = Math.ceil(buildReviewPrompt(db, sessionId).length / 4);
	const per1k = reviewCostPer1kContext(db);
	if (per1k !== null) return (ctx / 1000) * per1k;
	const model =
		cfg.ai.model ??
		db
			.prepare("SELECT model FROM usage WHERE session_id = ? AND model IS NOT NULL ORDER BY ts DESC, id DESC LIMIT 1")
			.get<{ model: string }>(sessionId)?.model;
	if (!model) return null;
	return estimateCost({
		model: priceableModel(model),
		inputTokens: ctx,
		outputTokens: OUTPUT_TOKENS,
		cacheCreationTokens: 0,
		cacheCreation1hTokens: 0,
		cacheReadTokens: 0,
	});
}

// ---- Eligibility (Phase 5a spec decision 5) ----

const OPEN_WINDOW_MS = 24 * 3_600_000; // no SessionEnd: ended once no line arrived for 24 h (as for summaries)

export type ReviewEligibility = {
	ended: boolean;
	crossesThreshold: boolean;
	eligible: boolean;
	autoEligible: boolean;
	/** Why it is not (auto-)eligible: reviews_disabled, open, below_threshold, reviewed, auto_off, imported. */
	reasons: string[];
};

/**
 * Whether the session may be reviewed: ended (a SessionEnd event, or no new line for 24 h), crosses a threshold (turns
 * above `autoThreshold.turns`, non-cached tokens above `autoThreshold.tokens`, or a high Tier 1 finding of a rule that is
 * not demoted), not yet reviewed, reviews on. Auto-eligible also needs `ai.review.auto` and a hook-captured session.
 */
export function reviewEligibility(db: Db, sessionId: string, cfg: Config, now: Date = new Date()): ReviewEligibility {
	const s = db
		.prepare(
			`SELECT s.capture, s.ended_at,
			   EXISTS (SELECT 1 FROM events e WHERE e.session_id = s.session_id AND e.event = 'SessionEnd') AS end_evt,
			   (SELECT count(*) FROM turns t WHERE t.session_id = s.session_id) AS turns,
			   (SELECT coalesce(sum(${costTokensSql()}), 0) FROM usage u WHERE u.session_id = s.session_id) AS tokens,
			   EXISTS (SELECT 1 FROM findings f LEFT JOIN rule_feedback rf ON rf.rule = f.rule
			           WHERE f.session_id = s.session_id AND f.severity = 'high' AND coalesce(rf.demoted, 0) = 0
			             AND f.rule NOT IN (${TIER2_RULES.map(() => "?").join(", ")})) AS high,
			   EXISTS (SELECT 1 FROM reviews r WHERE r.session_id = s.session_id) AS reviewed
			 FROM sessions s WHERE s.session_id = ?`,
		)
		.get<{
			capture: string;
			ended_at: string | null;
			end_evt: number;
			turns: number;
			tokens: number;
			high: number;
			reviewed: number;
		}>(...TIER2_RULES, sessionId);
	if (!s) {
		return { ended: false, crossesThreshold: false, eligible: false, autoEligible: false, reasons: ["unknown"] };
	}
	const { turns: maxTurns, tokens: maxTokens } = cfg.ai.review.autoThreshold;
	const ended = s.end_evt === 1 || (s.ended_at !== null && Date.parse(s.ended_at) < now.getTime() - OPEN_WINDOW_MS);
	const crossesThreshold = s.turns > maxTurns || s.tokens > maxTokens || s.high === 1;
	const reasons: string[] = [];
	if (!cfg.ai.review.enabled) reasons.push("reviews_disabled");
	if (!ended) reasons.push("open");
	if (!crossesThreshold) reasons.push("below_threshold");
	if (s.reviewed === 1) reasons.push("reviewed");
	const eligible = reasons.length === 0;
	if (!cfg.ai.review.auto) reasons.push("auto_off");
	if (s.capture !== "hooks") reasons.push("imported");
	return { ended, crossesThreshold, eligible, autoEligible: reasons.length === 0, reasons };
}

// ---- Findings from a review (feature 08 "Findings from a review"; spec decision 8) ----

const FRICTION_LABELS: Record<(typeof FRICTION_KINDS)[number], string> = {
	ambiguous_ask: "Ambiguous ask",
	missing_context: "Missing context",
	scope_creep: "Scope creep",
	wrong_tool: "Wrong tool",
	agent_confusion: "Agent confusion",
};

/** 1234 → "1.2k", 2_500_000 → "2.5M". */
const compact = (n: number): string =>
	n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${+(n / 1000).toFixed(1)}k` : String(Math.round(n));

/**
 * Tier 2 findings: one `goal_drift` (subject '') when the review has more than two goals or any goal change, and one
 * `review_friction` per friction entry (subject `turn:<n>:<kind>`). Turn n is the n-th turn of the stored-turns prompt;
 * a turn outside the session is dropped from the message, not the finding, and costs 0. Every finding carries
 * `evidence.confidence`.
 */
export function reviewFindings(result: ReviewResult, ctx: SessionContext): Finding[] {
	const turnAt = (n: number) => ctx.turns[n - 1];
	const out: Finding[] = [];
	const { confidence } = result;
	const change = [...result.goal_changes].sort((a, b) => a.turn - b.turn)[0];
	if (result.goals.length > 2 || change) {
		const n = Math.max(result.goals.length, change ? 2 : 0);
		const first = result.goals[0] ?? change?.from ?? "";
		let message: string;
		let costTokens: number;
		const turns: number[] = [];
		if (change && turnAt(change.turn)) {
			const t = change.turn;
			costTokens = ctx.turns.slice(t - 1).reduce((sum, x) => sum + x.tokens, 0);
			const before = t > 2 ? `turns 1–${t - 1}` : "turn 1";
			message = `${n} goals: ${first} (${t > 1 ? before : "from the start"}), then "${change.to}" at turn ${t} — ${compact(costTokens)} tokens on the later goal${n > 2 ? "s" : ""}; one session per goal, \`/clear\` between`;
			turns.push(t);
		} else if (change) {
			costTokens = 0;
			message = `${n} goals: ${first}, then "${change.to}"; one session per goal, \`/clear\` between`;
		} else {
			costTokens = Math.round((ctx.totals.tokens * (n - 1)) / n);
			message = `${n} goals: ${result.goals.map((g) => `"${g}"`).join(", ")} — ≈${compact(costTokens)} tokens on the later goals; one session per goal, \`/clear\` between`;
		}
		out.push({
			rule: "goal_drift",
			severity: "medium",
			message,
			evidence: { goals: result.goals, changeTurn: change?.turn ?? null, turns, confidence },
			costTokens,
			target: "session",
		});
	}
	for (const f of result.friction) {
		const turn = turnAt(f.turn);
		out.push({
			rule: "review_friction",
			severity: "low",
			message: `${FRICTION_LABELS[f.kind]}${turn ? ` at turn ${f.turn}` : ""}: ${f.note}`,
			evidence: {
				key: `turn:${f.turn}:${f.kind}`,
				turn: f.turn,
				kind: f.kind,
				turns: turn ? [f.turn] : [],
				confidence,
			},
			costTokens: turn?.tokens ?? 0,
			target: "session",
		});
	}
	return out;
}

// ---- reviewSession (feature 08 "Review run"; spec decisions 4, 6, 7) ----

export const REVIEW_TIMEOUT_MS = 180_000;
const ERROR_DETAIL = 120;

export type ReviewStatus = "done" | "capped" | "disabled" | "busy" | "open" | "skipped" | "error";
export type ReviewOutcome = { status: ReviewStatus; costUsd?: number | null; reason?: string; reviewId?: number };

/**
 * Reviews one session through the user's own login, by click or (trigger "auto") for an auto-eligible session. Order:
 * reviews on → the `review-<id>` lock (separate from ingest and enrich, no wait) → ended → auto-eligible for "auto" →
 * the daily cap (checked again atomically by runClaude) → the stored-turns prompt → one `claude -p` call, never retried
 * → validate → redact → the `reviews` row and the Tier 2 findings (a re-review replaces both; feedback and dismissals
 * of findings produced again are kept). Never throws for a failed call: the reason comes back with "error".
 */
export async function reviewSession(
	db: Db,
	sessionId: string,
	cfg: Config,
	opts: { trigger: "auto" | "click"; now?: Date; timeoutMs?: number },
): Promise<ReviewOutcome> {
	if (!cfg.ai.review.enabled) return { status: "disabled", reason: "reviews_disabled" };
	const now = opts.now ?? new Date();
	const r = await withSessionLock(`review-${sessionId}`, { waitMs: 0 }, () =>
		reviewLocked(db, sessionId, cfg, opts.trigger, now, opts.timeoutMs ?? REVIEW_TIMEOUT_MS),
	);
	return r === "busy" ? { status: "busy", reason: "review_in_flight" } : r;
}

async function reviewLocked(
	db: Db,
	sessionId: string,
	cfg: Config,
	trigger: "auto" | "click",
	now: Date,
	timeoutMs: number,
): Promise<ReviewOutcome> {
	if (!db.prepare("SELECT 1 AS x FROM sessions WHERE session_id = ?").get(sessionId)) {
		return { status: "error", reason: "unknown session" };
	}
	const e = reviewEligibility(db, sessionId, cfg, now);
	if (!e.ended) return { status: "open", reason: "session_open" };
	if (trigger === "auto" && !e.autoEligible) return { status: "skipped", reason: e.reasons.join(", ") };
	if (aiCallsToday(db, "review", now) >= cfg.ai.review.maxPerDay) {
		return { status: "capped", reason: "daily cap reached" };
	}

	let call: ClaudeResult<unknown>;
	try {
		call = await runClaude<unknown>({
			prompt: buildReviewPrompt(db, sessionId),
			schema: REVIEW_SCHEMA,
			feature: "review",
			model: cfg.ai.model,
			timeoutMs,
			db,
			targetSessionId: sessionId,
			cap: cfg.ai.review.maxPerDay,
			now,
		});
	} catch (err) {
		if (err instanceof ClaudeError && err.reason === "capped") return { status: "capped", reason: "daily cap reached" };
		return { status: "error", reason: errorReason(err) };
	}
	const parsed = ReviewResultSchema.safeParse(call.result);
	if (!parsed.success) {
		// The call is already in self_usage; nothing goes to reviews, and there is no retry.
		return {
			status: "error",
			costUsd: call.costUsd,
			reason: `schema: ${parsed.error.issues[0]?.message ?? "invalid"}`,
		};
	}
	const result = redactDeep(parsed.data, cfg.capture.redact, cfg.capture.maxFieldBytes);
	const findings = reviewFindings(result, loadSessionContext(db, sessionId));
	const reviewId = db.transaction(() => {
		const id = upsertReview(db, {
			sessionId,
			schemaVersion: REVIEW_SCHEMA_VERSION,
			result,
			costUsd: call.costUsd,
			model: call.model ?? null,
			createdAt: now.toISOString(),
		});
		upsertFindings(db, sessionId, TIER2_RULES, findings, now);
		return id;
	});
	return { status: "done", costUsd: call.costUsd, reviewId };
}

function errorReason(err: unknown): string {
	if (err instanceof ClaudeError) {
		const msg = err.message.slice(0, ERROR_DETAIL);
		return msg.startsWith(err.reason) ? msg : `${err.reason}: ${msg}`;
	}
	return `error: ${String((err as Error)?.message ?? err).slice(0, ERROR_DETAIL)}`;
}

// ---- Eligible sessions (digest footer, "Review all"; spec decision 2) ----

const DAY_MS = 86_400_000;

/** Eligible, unreviewed sessions started in the last `days` days, oldest first. */
export function eligibleReviewIds(db: Db, cfg: Config, now: Date = new Date(), days = 7): string[] {
	if (!cfg.ai.review.enabled) return [];
	return db
		.prepare(
			`SELECT s.session_id FROM sessions s
			 WHERE s.started_at >= ? AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.session_id = s.session_id)
			 ORDER BY s.started_at, s.session_id`,
		)
		.all<{ session_id: string }>(new Date(now.getTime() - days * DAY_MS).toISOString())
		.map((r) => r.session_id)
		.filter((id) => reviewEligibility(db, id, cfg, now).eligible);
}

/** The summed estimate for the sessions; null when any one is unknown. */
export function estimateReviewAll(db: Db, ids: string[], cfg: Config): number | null {
	let sum = 0;
	for (const id of ids) {
		const e = estimateReviewCost(db, id, cfg);
		if (e === null) return null;
		sum += e;
	}
	return sum;
}

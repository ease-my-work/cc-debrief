// Repeat-pattern detection (feature 10 "Detection run"; Phase 5b spec decisions 2, 6): pure JS over the DB, no git,
// no network, no model. Per repo: the last 30 days' sessions (500 newest, our own calls excluded) as a graph of label
// and fingerprint edges; components of ≥ 3 sessions over the digest cost floor become candidates, which are upserted
// into `patterns` (identity, else a 50% overlap merge) with one session-less finding each.
import { costTokensSql } from "../coach/digest-rules/shared";
import type { Finding } from "../coach/types";
import type { Db } from "../db/adapter";
import { upsertFindings } from "../db/queries/findings";
import {
	deletePattern,
	findOverlappingPattern,
	findPatternByIdentity,
	listPatternRows,
	type Pattern,
	type PatternKind,
	setPatternStatus,
	upsertPattern,
} from "../db/queries/patterns";
import { decodePayload } from "../ingest/line";
import { type Candidate, type DetectSession, MIN_SESSIONS, qualifies, sumTokens } from "./candidate";
import { classifyComponent, correctionCandidates, pointerCandidate } from "./classify";
import { fingerprintable, fingerprintText, toolSkeleton, trigrams } from "./fingerprint";
import { buildGraph, components } from "./graph";
import { normalizeLabel } from "./labels";

export type { Candidate, DetectSession, PatternKind };
export { MIN_SESSIONS, qualifies };

export const WINDOW_DAYS = 30;
export const MAX_SESSIONS = 500;
const DISMISS_RETURN_DAYS = 30;
const DAY_MS = 86_400_000;

/** Kinds that per-repo detection owns (user_skill belongs to the cross-repo run). */
export const REPO_KINDS: PatternKind[] = ["repo_skill", "claude_md_rule", "claude_md_pointer", "test_gap"];
export const PATTERN_FINDING_RULES = ["repeat_pattern", "test_gap"];

const placeholders = (n: number) => Array.from({ length: n }, () => "?").join(", ");

/**
 * Sessions started in the last 30 days (500 newest) matching `where` (an SQL condition on alias s), with everything
 * detection reads, oldest first. The tracker's own call sessions are excluded.
 */
export function loadDetectSessions(
	db: Db,
	where: { sql: string; params: unknown[] },
	now: Date,
	limit = MAX_SESSIONS,
): DetectSession[] {
	const rows = db
		.prepare(
			`SELECT s.session_id, s.repo_id, s.started_at, s.ended_at, s.session_type FROM sessions s
			 WHERE s.started_at >= ? AND ${where.sql}
			   AND NOT EXISTS (SELECT 1 FROM self_usage u WHERE u.session_id = s.session_id)
			   AND NOT EXISTS (SELECT 1 FROM ai_calls a WHERE a.session_id = s.session_id)
			 ORDER BY s.started_at DESC, s.session_id DESC LIMIT ?`,
		)
		.all<{
			session_id: string;
			repo_id: string | null;
			started_at: string;
			ended_at: string | null;
			session_type: string | null;
		}>(new Date(now.getTime() - WINDOW_DAYS * DAY_MS).toISOString(), ...where.params, limit)
		.reverse();
	if (rows.length === 0) return [];
	const ids = rows.map((r) => r.session_id);
	const inList = placeholders(ids.length);
	const tokens = new Map(
		db
			.prepare(
				`SELECT session_id, coalesce(sum(${costTokensSql()}), 0) AS t FROM usage WHERE session_id IN (${inList}) GROUP BY session_id`,
			)
			.all<{ session_id: string; t: number }>(...ids)
			.map((r) => [r.session_id, r.t]),
	);
	const labels = new Map(
		db
			.prepare(
				`SELECT session_id, json_extract(result, '$.task_pattern') AS label FROM reviews
				 WHERE session_id IN (${inList}) ORDER BY created_at`,
			)
			.all<{ session_id: string; label: string | null }>(...ids)
			.filter((r) => typeof r.label === "string" && r.label.trim() !== "")
			.map((r) => [r.session_id, (r.label as string).trim()]),
	);
	const prompts = new Map<string, string[]>();
	for (const t of db
		.prepare(`SELECT session_id, user_text FROM turns WHERE session_id IN (${inList}) ORDER BY session_id, seq`)
		.all<{ session_id: string; user_text: string | null }>(...ids)) {
		prompts.set(t.session_id, [...(prompts.get(t.session_id) ?? []), t.user_text ?? ""]);
	}
	const calls = new Map<string, { tool_name: string; input: unknown; mcp_server: string | null }[]>();
	for (const c of db
		.prepare(
			`SELECT session_id, tool_name, mcp_server, input FROM tool_calls
			 WHERE session_id IN (${inList}) AND agent_id IS NULL ORDER BY session_id, started_at, id`,
		)
		.all<{ session_id: string; tool_name: string; mcp_server: string | null; input: Uint8Array | null }>(...ids)) {
		let input: unknown = {};
		// Only shell and file tools use their input (the command key or the path).
		if (c.input && !c.mcp_server && /^(Bash|PowerShell|Read|Edit|Write|MultiEdit|NotebookEdit)$/.test(c.tool_name)) {
			try {
				input = decodePayload(c.input);
			} catch {
				input = {};
			}
		}
		calls.set(c.session_id, [
			...(calls.get(c.session_id) ?? []),
			{ tool_name: c.tool_name, input, mcp_server: c.mcp_server },
		]);
	}
	const edits = new Map<string, string[]>();
	for (const f of db
		.prepare(`SELECT DISTINCT session_id, path FROM file_changes WHERE session_id IN (${inList})`)
		.all<{ session_id: string; path: string }>(...ids)) {
		edits.set(f.session_id, [...(edits.get(f.session_id) ?? []), f.path]);
	}
	return rows.map((r) => {
		const own = calls.get(r.session_id) ?? [];
		const steps = toolSkeleton(own);
		const label = labels.get(r.session_id) ?? null;
		const earlyReads = own
			.slice(0, 5)
			.filter((c) => c.tool_name === "Read")
			.map((c) => (c.input as { file_path?: unknown }).file_path)
			.filter((p): p is string => typeof p === "string");
		return {
			id: r.session_id,
			repoId: r.repo_id,
			startedAt: r.started_at,
			endedAt: r.ended_at,
			sessionType: r.session_type,
			tokens: tokens.get(r.session_id) ?? 0,
			label,
			labelNorm: label ? normalizeLabel(label) || null : null,
			steps,
			trigrams: fingerprintable(steps) ? trigrams(steps) : new Set(),
			prompts: prompts.get(r.session_id) ?? [],
			edits: edits.get(r.session_id) ?? [],
			earlyReads: [...new Set(earlyReads)],
		};
	});
}

/** The newest member with a fingerprintable skeleton, as display text. */
function newestFingerprint(ss: DetectSession[]): string | null {
	for (let i = ss.length - 1; i >= 0; i--) if (ss[i].trigrams.size > 0) return fingerprintText(ss[i].steps);
	return null;
}

/**
 * Feature 10 step 5: the most frequent normalized Tier 2 label (shown as its newest raw form); without labels, the
 * newest session's fingerprint.
 */
export function pickLabel(ss: DetectSession[]): { label: string; labelNorm: string } | null {
	const counts = new Map<string, number>();
	for (const s of ss) if (s.labelNorm) counts.set(s.labelNorm, (counts.get(s.labelNorm) ?? 0) + 1);
	if (counts.size > 0) {
		const top = Math.max(...counts.values());
		// Ties go to the label used most recently (members are oldest first).
		for (let i = ss.length - 1; i >= 0; i--) {
			const s = ss[i];
			if (s.labelNorm && counts.get(s.labelNorm) === top) return { label: s.label as string, labelNorm: s.labelNorm };
		}
	}
	const fp = newestFingerprint(ss);
	return fp ? { label: fp, labelNorm: `fp:${fp.toLowerCase()}` } : null;
}

/** Components of the label / fingerprint graph that qualify, as repo_skill candidates (Task 4 classifies them). */
export function clusterCandidates(sessions: DetectSession[]): Candidate[] {
	const edges = buildGraph(
		sessions.map((s) => ({ id: s.id, label: s.labelNorm, trigrams: s.trigrams, firstPrompt: s.prompts[0] ?? "" })),
	);
	const out: Candidate[] = [];
	for (const comp of components(sessions.length, edges)) {
		const members = comp.map((i) => sessions[i]);
		if (!qualifies(members)) continue;
		const picked = pickLabel(members);
		if (!picked) continue;
		out.push({ kind: "repo_skill", ...picked, sessions: members, fingerprint: newestFingerprint(members), meta: {} });
	}
	return out;
}

function findingFor(p: Pattern, repoName: string | null): Finding {
	const n = p.sessionIds.length;
	const where = repoName ? ` in \`${repoName}\`` : "";
	const message =
		p.kind === "test_gap"
			? `\`${p.meta.testGapPath ?? p.label}\` fixed in ${n} separate bugfix sessions${where} — no test covers it`
			: p.kind === "claude_md_rule"
				? `Corrected by you in ${p.meta.correctionCount ?? n} sessions${where}: "${p.label}"`
				: p.kind === "claude_md_pointer"
					? `The same files are read at the start of ${n} sessions${where}`
					: `Repeated work${where}: ${p.label} — ${n} sessions in 30 days`;
	return {
		rule: p.kind === "test_gap" ? "test_gap" : "repeat_pattern",
		severity: "low",
		message,
		evidence: { key: `pattern:${p.id}`, patternId: p.id, kind: p.kind, repoId: p.repoId, sessions: n },
		costTokens: p.tokensTotal,
		target: "repos",
	};
}

/**
 * Writes a run's candidates for one scope (a repo, or null with the cross-repo kinds): identity or ≥ 50% overlap
 * upsert; a dismissed row older than 30 days returns to candidate; scope rows of these kinds that no longer qualify are
 * deleted while still candidates (drafted / installed / dismissed rows stay); one finding per qualifying candidate or
 * drafted row, replacing the scope's earlier pattern findings.
 */
export function syncCandidates(
	db: Db,
	repoId: string | null,
	kinds: PatternKind[],
	candidates: Candidate[],
	now: Date,
): { created: number; updated: number } {
	let created = 0;
	let updated = 0;
	return db.transaction(() => {
		const matched = new Set<number>();
		for (const c of candidates) {
			let ids = c.sessions.map((s) => s.id);
			const existing =
				findPatternByIdentity(db, repoId, c.kind, c.labelNorm) ?? findOverlappingPattern(db, repoId, c.kind, ids);
			// An installed row keeps the sessions it had (Phase 5b spec decision 7): its before-install ones age out of
			// the 30-day window but still make the "before" median.
			if (existing?.status === "installed") {
				const fresh = new Set(ids);
				ids = [...existing.sessionIds.filter((id) => !fresh.has(id)), ...ids];
			}
			// A merged row keeps its own identity when another row already has the candidate's.
			const r = upsertPattern(db, {
				id: existing?.id,
				repoId,
				label: existing && existing.labelNorm !== c.labelNorm ? existing.label : c.label,
				labelNorm: existing && existing.labelNorm !== c.labelNorm ? existing.labelNorm : c.labelNorm,
				kind: c.kind,
				sessionIds: ids,
				tokensTotal: sumTokens(c.sessions),
				fingerprint: c.fingerprint,
				firstSeen: c.sessions[0].startedAt,
				lastSeen: c.sessions.at(-1)?.startedAt ?? c.sessions[0].startedAt,
				meta: c.meta,
			});
			if (r.created) created++;
			if (r.updated) updated++;
			matched.add(r.id);
			if (
				existing?.status === "dismissed" &&
				existing.dismissedAt &&
				Date.parse(existing.dismissedAt) < now.getTime() - DISMISS_RETURN_DAYS * DAY_MS
			) {
				setPatternStatus(db, r.id, "candidate", { now });
				updated++;
			}
		}
		const scope = listPatternRows(db, { repo: repoId }).filter((p) => kinds.includes(p.kind));
		for (const p of scope) {
			if (!matched.has(p.id) && p.status === "candidate") {
				deletePattern(db, p.id);
				updated++;
			}
		}
		const repoName =
			repoId === null
				? null
				: (db.prepare("SELECT name FROM repos WHERE repo_id = ?").get<{ name: string }>(repoId)?.name ?? null);
		const findings = listPatternRows(db, { repo: repoId })
			.filter((p) => matched.has(p.id) && (p.status === "candidate" || p.status === "drafted"))
			.map((p) => findingFor(p, repoName));
		syncPatternFindings(db, repoId, kinds, findings, now);
		return { created, updated };
	});
}

/**
 * Pattern findings of one scope (spec decision 6): upserts the produced ones by subject `pattern:<id>` and deletes the
 * scope's other pattern findings of these kinds (without feedback). upsertFindings() alone would replace every repo's.
 */
function syncPatternFindings(
	db: Db,
	repoId: string | null,
	kinds: PatternKind[],
	findings: Finding[],
	now: Date,
): void {
	upsertFindings(db, null, [], findings, now);
	const keep = new Set(findings.map((f) => String(f.evidence.key)));
	const rows = db
		.prepare(
			`SELECT id, subject_key, json_extract(evidence, '$.kind') AS kind FROM findings
			 WHERE session_id IS NULL AND repo_id IS ? AND feedback IS NULL
			   AND rule IN (${placeholders(PATTERN_FINDING_RULES.length)})`,
		)
		.all<{ id: number; subject_key: string; kind: PatternKind | null }>(repoId, ...PATTERN_FINDING_RULES);
	const del = db.prepare("DELETE FROM findings WHERE id = ?");
	for (const r of rows) if (!keep.has(r.subject_key) && (r.kind === null || kinds.includes(r.kind))) del.run(r.id);
}

/**
 * Rule 3 before rule 4: a label-free component whose members stop being fingerprintable once the pointer's start-up
 * reads are taken out is the pointer itself, not a repo skill (Phase 5b build).
 */
function explainedByPointer(c: Candidate, pointer: Candidate): boolean {
	if (c.sessions.some((s) => s.labelNorm)) return false;
	const files = (pointer.meta.readFiles ?? []).map((f) => f.split("/").pop() ?? f);
	return c.sessions.every((s) => !fingerprintable(s.steps.filter((st) => !files.some((f) => st === `Read:${f}`))));
}

/** Candidates with one identity (kind and normalized label) are one: their sessions are joined, oldest first. */
export function dedupe(candidates: Candidate[]): Candidate[] {
	const byKey = new Map<string, Candidate>();
	for (const c of candidates) {
		const key = `${c.kind} ${c.labelNorm}`;
		const seen = byKey.get(key);
		if (!seen) {
			byKey.set(key, c);
			continue;
		}
		const ids = new Set(seen.sessions.map((s) => s.id));
		seen.sessions = [...seen.sessions, ...c.sessions.filter((s) => !ids.has(s.id))].sort((a, b) =>
			a.startedAt.localeCompare(b.startedAt),
		);
	}
	return [...byKey.values()];
}

/**
 * Per-repo detection (feature 10): the graph's qualifying components classified (rules 1, 2, else repo_skill), plus
 * the repo-wide rule 2 and rule 3 candidates, written by syncCandidates(). Sessions without a repo are left to the
 * cross-repo run.
 */
export function detectPatterns(
	db: Db,
	repoId: string | null,
	now: Date = new Date(),
): { created: number; updated: number } {
	if (repoId === null) return { created: 0, updated: 0 };
	const sessions = loadDetectSessions(db, { sql: "s.repo_id = ?", params: [repoId] }, now);
	const root =
		db.prepare("SELECT root_path FROM repos WHERE repo_id = ?").get<{ root_path: string | null }>(repoId)?.root_path ??
		null;
	const pointer = pointerCandidate(sessions, root);
	const candidates = clusterCandidates(sessions)
		.filter((c) => !(pointer && explainedByPointer(c, pointer)))
		.map(classifyComponent);
	candidates.push(...correctionCandidates(sessions));
	if (pointer) candidates.push(pointer);
	return syncCandidates(db, repoId, REPO_KINDS, dedupe(candidates), now);
}

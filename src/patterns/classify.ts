// Pattern classification (feature 10 step 4, first match wins): a component of bugfix sessions on one file is a test
// gap; repeated corrections are a CLAUDE.md rule; the same start-up reads are a pointer paragraph; anything else is a
// repo skill. Rules 2 and 3 are also evaluated over all the repo's sessions, apart from the graph.
import { type Candidate, type DetectSession, MIN_SESSIONS, qualifies } from "./candidate";
import { components } from "./graph";
import { normalizeLabel } from "./labels";
import { tfidfCosine } from "./similarity";

const CORRECTION_COSINE = 0.5;
const POINTER_SHARE = 0.5;
const LABEL_MAX = 200;

/** Correction phrases (feature 10 rule 2), English only. */
const CORRECTION =
	/\buse\s+[\w.@/-]+,?\s+not\s+[\w.@/-]+|\bdon'?t\b|\bdo not\b|\binstead of\b|\binstead\b|\bstop\b|\bnever\b/i;

const sentences = (text: string) =>
	text
		.split(/(?<=[.!?])\s+|\n+/)
		.map((s) => s.trim())
		.filter(Boolean);

/** The correction sentences of a session's non-first prompts. */
export function corrections(s: DetectSession): string[] {
	return s.prompts
		.slice(1)
		.flatMap(sentences)
		.filter((x) => CORRECTION.test(x));
}

/** Rule 1: ≥ 3 bugfix sessions of the component edit the same path; that path, else null. */
export function testGapPath(members: DetectSession[]): string | null {
	const counts = new Map<string, number>();
	for (const s of members) {
		if (s.sessionType !== "bugfix") continue;
		for (const p of new Set(s.edits)) counts.set(p, (counts.get(p) ?? 0) + 1);
	}
	let best: { path: string; n: number } | null = null;
	for (const [path, n] of counts) if (n >= MIN_SESSIONS && (!best || n > best.n)) best = { path, n };
	return best?.path ?? null;
}

/**
 * Rule 2 over a set of sessions: correction sentences linked by TF-IDF cosine ≥ 0.5 (connected, so each is that close
 * to another of the group) from ≥ 3 sessions. Label = the most central sentence (highest summed cosine).
 */
export function correctionCandidates(sessions: DetectSession[]): Candidate[] {
	const items = sessions.flatMap((s) => corrections(s).map((text) => ({ s, text })));
	if (items.length < MIN_SESSIONS) return [];
	const cos = tfidfCosine(items.map((i) => i.text));
	const edges: { a: number; b: number; weight: number; label: boolean; fingerprint: number; corroborated: boolean }[] =
		[];
	for (let a = 0; a < items.length; a++)
		for (let b = a + 1; b < items.length; b++)
			if (items[a].s !== items[b].s && cos[a][b] >= CORRECTION_COSINE)
				edges.push({ a, b, weight: cos[a][b], label: false, fingerprint: 0, corroborated: true });
	const out: Candidate[] = [];
	for (const comp of components(items.length, edges)) {
		const members = [...new Set(comp.map((i) => items[i].s))].sort((x, y) => x.startedAt.localeCompare(y.startedAt));
		if (members.length < MIN_SESSIONS || !qualifies(members)) continue;
		let central = comp[0];
		let bestSum = -1;
		for (const i of comp) {
			const sum = comp.reduce((n, j) => n + (i === j ? 0 : cos[i][j]), 0);
			if (sum > bestSum) [central, bestSum] = [i, sum];
		}
		const label = items[central].text.slice(0, LABEL_MAX);
		out.push({
			kind: "claude_md_rule",
			label,
			labelNorm: normalizeLabel(label) || label.toLowerCase(),
			sessions: members,
			fingerprint: null,
			meta: { correctionCount: members.length, corrections: comp.map((i) => items[i].text) },
		});
	}
	return out;
}

/** A path relative to the repo root, with forward slashes. */
function relative(path: string, root: string | null): string {
	const p = path.replace(/\\/g, "/");
	const r = root?.replace(/\\/g, "/").replace(/\/+$/, "");
	return r && p.toLowerCase().startsWith(`${r.toLowerCase()}/`) ? p.slice(r.length + 1) : p;
}

/**
 * Rule 3: a set of ≥ 2 files Read among the first five tool calls of ≥ 50% of the repo's sessions (minimum 3). The
 * files each read that often form the set; when too few sessions read all of them, the two most frequent are tried.
 */
export function pointerCandidate(sessions: DetectSession[], root: string | null): Candidate | null {
	const need = Math.max(MIN_SESSIONS, Math.ceil(sessions.length * POINTER_SHARE));
	const reads = sessions.map((s) => new Set(s.earlyReads.map((p) => relative(p, root))));
	const counts = new Map<string, number>();
	for (const r of reads) for (const p of r) counts.set(p, (counts.get(p) ?? 0) + 1);
	const frequent = [...counts].filter(([, n]) => n >= need).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
	for (const set of [frequent.map(([p]) => p), frequent.slice(0, 2).map(([p]) => p)]) {
		if (set.length < 2) continue;
		const members = sessions.filter((_, i) => set.every((p) => reads[i].has(p)));
		if (members.length < need || !qualifies(members)) continue;
		const files = [...set].sort();
		return {
			kind: "claude_md_pointer",
			label: `Read at session start: ${files.join(", ")}`,
			labelNorm: `pointer:${files.join("|").toLowerCase()}`,
			sessions: members,
			fingerprint: null,
			meta: { readFiles: files },
		};
	}
	return null;
}

/**
 * Classifies one qualifying component (rules 1, 2, then the default; rule 3 is repo-wide only, since it is defined
 * over all the repo's sessions).
 */
export function classifyComponent(base: Candidate): Candidate {
	const gap = testGapPath(base.sessions);
	if (gap) {
		return {
			...base,
			kind: "test_gap",
			label: gap,
			labelNorm: `path:${gap.replace(/\\/g, "/").toLowerCase()}`,
			meta: { testGapPath: gap },
		};
	}
	const [rule] = correctionCandidates(base.sessions);
	if (rule) return rule;
	return base;
}

// The session graph of repeat-pattern detection (feature 10 "Detection run" steps 2-3): an edge joins two sessions
// with the same normalized task label (weight 1) or a fingerprint Jaccard ≥ 0.6 (weight = the Jaccard); prompt
// TF-IDF ≥ 0.5 marks an existing edge corroborated and never creates one. Components are union-find sets.
import { setJaccard } from "./fingerprint";
import { sameLabel } from "./labels";
import { tfidfCosine } from "./similarity";

export const FINGERPRINT_JACCARD = 0.6;
export const PROMPT_COSINE = 0.5;

export type GraphSession = {
	id: string;
	/** Normalized Tier 2 label, or null. */
	label: string | null;
	/** Trigram set of the skeleton; empty when not fingerprintable. */
	trigrams: Set<string>;
	firstPrompt: string;
};

export type Edge = { a: number; b: number; weight: number; label: boolean; fingerprint: number; corroborated: boolean };

export function buildGraph(sessions: GraphSession[]): Edge[] {
	const cos = tfidfCosine(sessions.map((s) => s.firstPrompt));
	// Labels repeat: compare each distinct pair of labels once.
	const labels = [...new Set(sessions.map((s) => s.label).filter((l): l is string => !!l))];
	const same = new Map<string, boolean>();
	const key = (x: string, y: string) => (x < y ? `${x}\u0000${y}` : `${y}\u0000${x}`);
	for (let i = 0; i < labels.length; i++)
		for (let j = i; j < labels.length; j++) same.set(key(labels[i], labels[j]), sameLabel(labels[i], labels[j]));
	const edges: Edge[] = [];
	for (let a = 0; a < sessions.length; a++) {
		for (let b = a + 1; b < sessions.length; b++) {
			const x = sessions[a];
			const y = sessions[b];
			const label = !!x.label && !!y.label && (same.get(key(x.label, y.label)) ?? false);
			const j = setJaccard(x.trigrams, y.trigrams);
			const fingerprint = j >= FINGERPRINT_JACCARD ? j : 0;
			if (!label && fingerprint === 0) continue;
			edges.push({
				a,
				b,
				weight: (label ? 1 : 0) + fingerprint,
				label,
				fingerprint,
				corroborated: cos[a][b] >= PROMPT_COSINE,
			});
		}
	}
	return edges;
}

/** Connected components as lists of session indexes, each ordered, largest first. */
export function components(n: number, edges: Edge[]): number[][] {
	const parent = Array.from({ length: n }, (_, i) => i);
	const find = (i: number): number => {
		while (parent[i] !== i) {
			parent[i] = parent[parent[i]];
			i = parent[i];
		}
		return i;
	};
	for (const e of edges) {
		const ra = find(e.a);
		const rb = find(e.b);
		if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
	}
	const groups = new Map<number, number[]>();
	for (let i = 0; i < n; i++) {
		const r = find(i);
		groups.set(r, [...(groups.get(r) ?? []), i]);
	}
	return [...groups.values()].sort((x, y) => y.length - x.length || x[0] - y[0]);
}

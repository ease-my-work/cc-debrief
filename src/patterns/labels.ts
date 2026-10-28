// Task-label normalization (feature 10 signal 1): Tier 2 review labels that name the same task are one pattern.
import { terms } from "./similarity";

const SAME_LABEL_JACCARD = 0.8;

/** Lowercased, punctuation and stopwords dropped, lightly stemmed, distinct tokens in order: "fix trivy finding". */
export function normalizeLabel(label: string): string {
	return [...new Set(terms(label))].join(" ");
}

/** Equal after normalization, or token-set Jaccard ≥ 0.8. Empty labels never match. */
export function sameLabel(a: string, b: string): boolean {
	const x = new Set(normalizeLabel(a).split(" ").filter(Boolean));
	const y = new Set(normalizeLabel(b).split(" ").filter(Boolean));
	if (x.size === 0 || y.size === 0) return false;
	let shared = 0;
	for (const t of x) if (y.has(t)) shared++;
	return shared / (x.size + y.size - shared) >= SAME_LABEL_JACCARD;
}

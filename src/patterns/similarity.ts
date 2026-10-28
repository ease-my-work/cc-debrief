// Text similarity for repeat-pattern detection (feature 10 signals 1 and 3): the tokenizer shared with label
// normalization, and TF-IDF cosine over first prompts. Pure JS. The tokenizer and stopword list are the ones Phase 4's
// removed src/coach/text-match.ts used (git 30c8b75^).

/** Fixed English stopword list. */
export const STOPWORDS: ReadonlySet<string> = new Set([
	"about",
	"after",
	"again",
	"all",
	"also",
	"and",
	"any",
	"are",
	"but",
	"can",
	"could",
	"did",
	"does",
	"doing",
	"for",
	"from",
	"get",
	"had",
	"has",
	"have",
	"her",
	"here",
	"him",
	"his",
	"how",
	"into",
	"its",
	"just",
	"let",
	"like",
	"make",
	"may",
	"more",
	"most",
	"need",
	"not",
	"now",
	"off",
	"one",
	"only",
	"our",
	"out",
	"over",
	"please",
	"same",
	"she",
	"should",
	"some",
	"such",
	"than",
	"that",
	"the",
	"their",
	"them",
	"then",
	"there",
	"these",
	"they",
	"this",
	"those",
	"too",
	"use",
	"using",
	"very",
	"want",
	"was",
	"way",
	"were",
	"what",
	"when",
	"where",
	"which",
	"while",
	"who",
	"why",
	"will",
	"with",
	"would",
	"yes",
	"yet",
	"you",
	"your",
]);

const MIN_LEN = 3;

const cut = (word: string, n: number) => (word.length - n >= MIN_LEN ? word.slice(0, -n) : word);

/**
 * Light stemmer (feature 10): the plural first (`-es` after s, x, z, ch, sh; else `-s`, but not `-ss`, `-us`,
 * `-is`), then `-ing` or `-ed`, keeping at least MIN_LEN characters. Every form of a word lands on one stem:
 * findings, finding → find; fixes, fixed, fixing → fix (Phase 5b build: the Phase 4 stemmer stripped one suffix, so
 * "findings" and "finding" differed).
 */
function stem(word: string): string {
	let w = word;
	if (/(s|x|z|ch|sh)es$/.test(w)) w = cut(w, 2);
	else if (w.endsWith("s") && !/(ss|us|is)$/.test(w)) w = cut(w, 1);
	if (w.endsWith("ing")) w = cut(w, 3);
	else if (w.endsWith("ed")) w = cut(w, 2);
	return w;
}

/** Lowercase tokens split on non-alphanumerics, stopwords and tokens under 3 characters dropped, stemmed. */
export function terms(text: string): string[] {
	const out: string[] = [];
	for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
		if (raw.length < MIN_LEN || STOPWORDS.has(raw)) continue;
		const t = stem(raw);
		if (t.length >= MIN_LEN && !STOPWORDS.has(t)) out.push(t);
	}
	return out;
}

/**
 * Pairwise cosine similarity of the documents' TF-IDF vectors (smoothed idf = ln((n + 1) / (df + 1)) + 1). Symmetric;
 * the diagonal is 1 for a document with any terms and 0 for one without.
 */
export function tfidfCosine(docs: string[]): number[][] {
	const tokenized = docs.map(terms);
	const df = new Map<string, number>();
	for (const toks of tokenized) for (const t of new Set(toks)) df.set(t, (df.get(t) ?? 0) + 1);
	const n = docs.length;
	const vectors = tokenized.map((toks) => {
		const tf = new Map<string, number>();
		for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
		const v = new Map<string, number>();
		let norm = 0;
		for (const [t, c] of tf) {
			const w = c * (Math.log((n + 1) / ((df.get(t) ?? 0) + 1)) + 1);
			v.set(t, w);
			norm += w * w;
		}
		return { v, norm: Math.sqrt(norm) };
	});
	const out = Array.from({ length: n }, () => new Array<number>(n).fill(0));
	for (let i = 0; i < n; i++) {
		out[i][i] = vectors[i].norm > 0 ? 1 : 0;
		for (let j = i + 1; j < n; j++) {
			const a = vectors[i];
			const b = vectors[j];
			if (a.norm === 0 || b.norm === 0) continue;
			const [small, large] = a.v.size <= b.v.size ? [a.v, b.v] : [b.v, a.v];
			let dot = 0;
			for (const [t, w] of small) dot += w * (large.get(t) ?? 0);
			const c = Math.min(1, dot / (a.norm * b.norm));
			out[i][j] = c;
			out[j][i] = c;
		}
	}
	return out;
}

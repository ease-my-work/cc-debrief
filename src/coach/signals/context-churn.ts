// Signal 5, context churn: the same file Read ≥ 4 times in one session (feature 07 row 5, detail 5).
import type { Finding, Signal } from "../types";

const MIN_READS = 4;
const MEDIUM_READS = 8;

/**
 * Feature 04 path form: "/" separators, no trailing slash; Windows drive paths compare case-insensitively.
 * Returns the display path and the grouping key.
 */
export function normalizePath(raw: string): { path: string; key: string } {
	const path = raw.replace(/\\/g, "/").replace(/\/+$/, "");
	return { path, key: /^[A-Za-z]:\//.test(path) ? path.toLowerCase() : path };
}

const basename = (path: string) => path.split("/").pop() || path;

export const contextChurn: Signal = {
	rule: "context_churn",
	detect(ctx) {
		// Every Read that ran (subagents included; denied reads never did), grouped by file in call order.
		const groups = new Map<string, { path: string; bytes: number[]; turns: Set<number> }>();
		for (const c of ctx.toolCalls) {
			if (c.toolName !== "Read" || c.denied) continue;
			const raw = c.input.file_path ?? c.input.path;
			if (typeof raw !== "string" || raw === "") continue;
			const { path, key } = normalizePath(raw);
			const g = groups.get(key) ?? { path, bytes: [], turns: new Set<number>() };
			g.bytes.push(c.responseBytes);
			if (c.turnSeq !== null) g.turns.add(c.turnSeq);
			groups.set(key, g);
		}
		const out: Finding[] = [];
		for (const [key, g] of groups) {
			const count = g.bytes.length;
			if (count < MIN_READS) continue;
			out.push({
				rule: this.rule,
				severity: count >= MEDIUM_READS ? "medium" : "low",
				message: `\`${basename(g.path)}\` read ${count} times — pin key facts in CLAUDE.md or keep sessions shorter`,
				evidence: { key, file: g.path, count, turns: [...g.turns].sort((a, b) => a - b) },
				costTokens: g.bytes.slice(1).reduce((n, b) => n + Math.ceil(b / 4), 0),
				target: "session",
			});
		}
		return out;
	},
};

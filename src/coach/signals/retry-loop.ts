// Signal 4, retry loop: the same tool with similar input failing ≥ 3 times in a row (feature 07 row 4, detail 4).
import { commandKey } from "../command-key";
import { costTokensOf } from "../context";
import type { ContextToolCall, Finding, SessionContext, Signal } from "../types";

const MIN_FAILURES = 3;
const HIGH_SHARE = 0.25;
export const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);
const TARGET_FIELDS = ["file_path", "path", "pattern", "url"] as const;

/**
 * Similar-input key: the command key for shell tools; else the tool name and its primary target
 * (`Read a.ts`); else the tool name and the input JSON.
 */
export function callKey(c: ContextToolCall): string {
	if (SHELL_TOOLS.has(c.toolName)) {
		const cmd = c.input.command;
		return commandKey(typeof cmd === "string" ? cmd : "") || c.toolName;
	}
	for (const f of TARGET_FIELDS) {
		const v = c.input[f];
		if (typeof v === "string" && v !== "") return `${c.toolName} ${v}`;
	}
	return `${c.toolName} ${JSON.stringify(c.input)}`;
}

/** A failed call (feature 07): ok = 0 and not denied. */
export const isFailure = (c: ContextToolCall) => c.ok === false && !c.denied;

/** Non-cached usage tokens (costTokensOf) with a ts in [from, to]. */
function tokensBetween(ctx: SessionContext, from: string | null, to: string | null): number {
	if (!from || !to) return 0;
	const a = Date.parse(from);
	const b = Date.parse(to);
	let n = 0;
	for (const u of ctx.usage) {
		if (!u.ts) continue;
		const t = Date.parse(u.ts);
		if (t >= a && t <= b) n += costTokensOf(u);
	}
	return n;
}

type Streak = { key: string; failures: ContextToolCall[]; closing: ContextToolCall | null };

export const retryLoop: Signal = {
	rule: "retry_loop",
	detect(ctx) {
		const open = new Map<string, ContextToolCall[]>();
		const streaks: Streak[] = [];
		for (const c of ctx.toolCalls) {
			// Denied calls (the user refused; not a retry) and calls without a result neither extend nor break a streak.
			if (c.denied || c.ok === null) continue;
			const key = callKey(c);
			if (isFailure(c)) {
				open.set(key, [...(open.get(key) ?? []), c]);
				continue;
			}
			const failures = open.get(key);
			if (failures && failures.length >= MIN_FAILURES) streaks.push({ key, failures, closing: c });
			open.delete(key);
		}
		for (const [key, failures] of open)
			if (failures.length >= MIN_FAILURES) streaks.push({ key, failures, closing: null });
		streaks.sort((a, b) => (a.failures[0].startedAt ?? "").localeCompare(b.failures[0].startedAt ?? ""));

		const seen = new Map<string, number>();
		return streaks.map((s): Finding => {
			const n = (seen.get(s.key) ?? 0) + 1;
			seen.set(s.key, n);
			const first = s.failures[0];
			const last = s.failures[s.failures.length - 1];
			const cost = tokensBetween(ctx, first.startedAt, (s.closing ?? last).endedAt);
			const share = ctx.totals.tokens > 0 ? cost / ctx.totals.tokens : 0;
			const pct = Math.round(share * 100);
			const passed = s.closing !== null;
			const count = s.failures.length;
			return {
				rule: "retry_loop",
				severity: share >= HIGH_SHARE ? "high" : "medium",
				message: passed
					? `${s.key} failed ${count} times before passing — ${pct}% of session tokens`
					: `${s.key} failed ${count} times in a row without passing — ${pct}% of session tokens`,
				evidence: {
					// A second streak of the same key in one session gets its own identity.
					key: n === 1 ? s.key : `${s.key} #${n}`,
					count,
					exitCodes: s.failures.map((f) => f.exitCode).filter((e): e is number => e !== null),
					firstTurn: first.turnSeq,
					lastTurn: last.turnSeq,
					passed,
					pct,
				},
				costTokens: cost,
				target: "session",
			};
		});
	},
};

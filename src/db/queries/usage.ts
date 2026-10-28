import type { UsageTotals } from "../../collector/transcript";
import type { Db } from "../adapter";

export type SessionTotals = {
	tokens: UsageTotals;
	costUsd: number | null;
	/** reported = Claude Code's own cost-state (matches /cost); counted = sum of usage rows, shown as "at least". */
	source: "reported" | "counted";
	partial: boolean;
};

type ReportedModel = { input?: number; output?: number; cacheRead?: number; cacheCreation?: number };

/** A session's total, the one number every view and threshold uses (feature 02 "Session totals"). */
export function sessionTotals(db: Db, sessionId: string): SessionTotals {
	const s = db
		.prepare("SELECT reported_cost_usd, reported_usage FROM sessions WHERE session_id = ?")
		.get<{ reported_cost_usd: number | null; reported_usage: string | null }>(sessionId);
	if (s?.reported_usage) {
		const models = JSON.parse(s.reported_usage) as Record<string, ReportedModel>;
		const tokens: UsageTotals = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
		for (const m of Object.values(models)) {
			tokens.inputTokens += m.input ?? 0;
			tokens.outputTokens += m.output ?? 0;
			tokens.cacheCreationTokens += m.cacheCreation ?? 0;
			tokens.cacheReadTokens += m.cacheRead ?? 0;
		}
		return { tokens, costUsd: s.reported_cost_usd, source: "reported", partial: false };
	}
	const u = db
		.prepare(
			`SELECT coalesce(sum(input_tokens), 0) AS i, coalesce(sum(output_tokens), 0) AS o,
			   coalesce(sum(cache_creation_tokens), 0) AS cw, coalesce(sum(cache_read_tokens), 0) AS cr,
			   sum(cost_usd) AS cost, count(*) AS n
			 FROM usage WHERE session_id = ?`,
		)
		.get<{ i: number; o: number; cw: number; cr: number; cost: number | null; n: number }>(sessionId);
	return {
		tokens: {
			inputTokens: u?.i ?? 0,
			outputTokens: u?.o ?? 0,
			cacheCreationTokens: u?.cw ?? 0,
			cacheReadTokens: u?.cr ?? 0,
		},
		// sum() over only NULLs is NULL (every model unknown); no rows at all is 0.
		costUsd: u && u.n > 0 ? u.cost : 0,
		source: "counted",
		partial: true,
	};
}

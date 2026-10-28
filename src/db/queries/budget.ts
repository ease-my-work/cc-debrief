// The monthly budget (Phase 7 P4, feature 18): month-to-date spend of the user's sessions in the local calendar
// month, projected to month end; levels per U2 (warn at ≥ 80% of the budget, over at ≥ 100%). The tracker's own
// calls live in self_usage and are not counted.
import type { Config } from "../../config";
import type { BudgetState } from "../../server/types";
import type { Db } from "../adapter";
import { money, totalsFor } from "./totals";

const WARN_SHARE = 0.8;

/** Month-to-date spend and tokens of sessions started since local midnight on the 1st. */
export function monthToDate(db: Db, now: Date): { usd: number; tokens: number } {
	const start = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
	let usd = 0;
	let tokens = 0;
	for (const t of totalsFor(db, "SELECT session_id FROM sessions WHERE started_at >= ?", [start]).values()) {
		usd += t.costUsd ?? 0;
		tokens += t.tokens;
	}
	return { usd: money(usd), tokens };
}

/** Null when budget.monthlyUsd is not set. */
export function getBudget(db: Db, cfg: Config, now: Date): BudgetState | null {
	const budgetUsd = cfg.budget.monthlyUsd;
	if (budgetUsd === null) return null;
	const { usd } = monthToDate(db, now);
	const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
	const elapsed = now.getDate(); // today included
	const projectedUsd = money((usd / elapsed) * daysInMonth);
	const level = projectedUsd >= budgetUsd ? "over" : projectedUsd >= budgetUsd * WARN_SHARE ? "warn" : "ok";
	return { budgetUsd, monthToDateUsd: usd, projectedUsd, level, daysLeft: daysInMonth - elapsed };
}

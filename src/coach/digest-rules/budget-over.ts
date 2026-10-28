// Digest item for the monthly budget (Phase 7 P4, U2): when the month's projection reaches budget.monthlyUsd, one
// finding for the month (subject key YYYY-MM), so it shows once however often the rules run.
import { loadConfig } from "../../config";
import { getBudget, monthToDate } from "../../db/queries/budget";
import type { DigestRule } from "../types";

const dollars = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

export const budgetOver: DigestRule = {
	rule: "budget_over",
	run(db, now) {
		const b = getBudget(db, loadConfig(), now);
		if (b?.level !== "over") return [];
		const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
		return [
			{
				rule: this.rule,
				severity: "medium",
				message: `On pace for ${dollars(b.projectedUsd)} this month, over the ${dollars(b.budgetUsd)} budget`,
				evidence: { key: month, month, ...b },
				costTokens: monthToDate(db, now).tokens,
				target: "overview",
			},
		];
	},
};

// The monthly budget band (Phase 7 P4, feature 18; mockup Costs.html) on Overview and Costs: month-to-date of the
// budget, the projection and days left, coloured by level (U2: warn at ≥ 80% projected, over at ≥ 100%).
import type { BudgetState } from "@api-types";
import { usd } from "../lib/format";

const TONE: Record<BudgetState["level"], string> = {
	ok: "bg-neutral-fill text-neutral-text",
	warn: "bg-amber-fill text-amber",
	over: "bg-bad-fill text-bad",
};

export function BudgetBand({ budget }: { budget: BudgetState | null }) {
	if (!budget) return null;
	const share = Math.min(100, (budget.monthToDateUsd / budget.budgetUsd) * 100);
	const pace =
		budget.level === "over"
			? `on pace for ${usd(budget.projectedUsd)}, over the ${usd(budget.budgetUsd)} budget`
			: `on pace for ${usd(budget.projectedUsd)}`;
	return (
		<div
			role="status"
			aria-label="Monthly budget"
			data-level={budget.level}
			className={`flex items-center gap-3.5 rounded-xl px-4 py-3 text-[13.5px] ${TONE[budget.level]}`}
		>
			<b className="font-semibold">
				{usd(budget.monthToDateUsd)} of {usd(budget.budgetUsd)} this month
			</b>
			<span aria-hidden="true" className="relative h-2 min-w-[80px] flex-grow overflow-hidden rounded bg-panel">
				<span className="absolute inset-y-0 left-0 bg-current" style={{ width: `${share}%` }} />
			</span>
			<span>
				{" · "}
				{pace} · {budget.daysLeft} {budget.daysLeft === 1 ? "day" : "days"} left
			</span>
		</div>
	);
}

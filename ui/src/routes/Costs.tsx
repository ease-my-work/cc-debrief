// Costs (Phase 7 P3 + P6, feature 18; mockup Costs.html): range and repo filters, tiles, cost per day by model, the
// run-rate line next to the plan prices (information only), cost by repo and by model.
import type { CostsResponse } from "@api-types";
import { Link } from "wouter";
import { BudgetBand } from "../components/BudgetBand";
import { CostChart } from "../components/CostChart";
import { EmptyState } from "../components/EmptyState";
import { ErrorCard } from "../components/ErrorCard";
import { ModelCostTable } from "../components/ModelCostTable";
import { RepoFilter } from "../components/RepoFilter";
import { Segmented } from "../components/Segmented";
import { SkeletonCard } from "../components/Skeleton";
import { StatTile } from "../components/StatTile";
import { TopBar } from "../components/TopBar";
import { compactTokens, usd } from "../lib/format";
import { SEGMENT_OPTIONS } from "../lib/ranges";
import { useApi } from "../lib/useApi";
import { useRange, useRepoFilter } from "../lib/useFilters";

/** The U5 line (Phase 7 spec): never says which plan the user has. */
export function runRateLine(r: CostsResponse["runRate"]): string {
	const plans = r.plans.map((p) => `${p.name} $${p.usd}`).join(" · ");
	return `Last 30 days at API prices: ≈ ${usd(r.monthlyUsd)}/month. ${plans} (prices as of ${r.pricesAsOf})`;
}

export function Costs() {
	const [range, setRange] = useRange("costs", "30d");
	const [repo, setRepo] = useRepoFilter();
	const { data, error, reload } = useApi<CostsResponse>("/api/costs", { range, repo });

	const top = (
		<TopBar title="Costs">
			<Segmented label="Date range" value={range} onChange={setRange} options={SEGMENT_OPTIONS} />
			<RepoFilter value={repo} onChange={setRepo} />
		</TopBar>
	);
	if (error && !data)
		return (
			<>
				{top}
				<ErrorCard error={error} onRetry={reload} />
			</>
		);
	if (!data)
		return (
			<>
				{top}
				<SkeletonCard height={360} />
			</>
		);

	const empty = data.totalUsd === 0 && data.models.length === 0;
	const byModel = data.models
		.filter((m) => m.usd !== null)
		.slice(0, 3)
		.map((m) => `${m.label} ${usd(m.usd)}`)
		.join(" · ");
	return (
		<>
			{top}
			{error ? <ErrorCard error={error} onRetry={reload} /> : null}
			<BudgetBand budget={data.budget} />
			<div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
				<StatTile label="Est. cost" value={usd(data.totalUsd)} sub={byModel || "no priced usage"} />
				<StatTile label="Cache hit" value={`${data.cacheHitPct}%`} sub="of input-side tokens read from cache" />
				<StatTile label="Cache saved" value={usd(data.cacheSavingsUsd)} sub="vs paying the input rate" />
				<StatTile
					label="Not priced"
					value={compactTokens(data.unknownModelTokens)}
					sub="tokens of models not in the price table"
				/>
			</div>
			{empty ? (
				<EmptyState
					title="No cost yet"
					hint="Costs appear once sessions in this range use a priced model."
					command={null}
				/>
			) : (
				<>
					<div className="card flex flex-col gap-2.5 px-[18px] py-4">
						<CostChart data={data.perDay} truncated={data.truncated} beforeUsd={data.beforeUsd} />
						{data.runRate.last30Usd > 0 ? (
							<div className="text-[13px] text-muted">{runRateLine(data.runRate)}</div>
						) : null}
					</div>
					<div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
						<div className="card overflow-x-auto">
							<div className="section-h px-4 pt-3.5 pb-1">Cost by repo</div>
							<table className="w-full text-[13.5px]" aria-label="Cost by repo">
								<thead>
									<tr>
										<th className="px-3 py-2 text-left text-[12px] font-semibold text-muted">Repo</th>
										<th className="px-3 py-2 text-right text-[12px] font-semibold text-muted">Cost</th>
									</tr>
								</thead>
								<tbody>
									{data.byRepo.map((r) => (
										<tr key={r.repoId ?? ""}>
											<td className="border-t border-row px-3 py-2.5">
												{r.repoId === null ? (
													<span className="text-muted">{r.name}</span>
												) : (
													<Link className="mono" href={`/repos/${encodeURIComponent(r.repoId)}`}>
														{r.name}
													</Link>
												)}
											</td>
											<td className="mono border-t border-row px-3 py-2.5 text-right">{usd(r.usd)}</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
						<ModelCostTable models={data.models} />
					</div>
				</>
			)}
		</>
	);
}

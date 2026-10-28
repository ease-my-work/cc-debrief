// Overview (feature 12; mockup Main.html): range and repo filters, four tiles, tokens per day, the digest card
// (empty until Phase 4) and recent sessions.
import type { Overview as OverviewData, Surface } from "@api-types";
import { BudgetBand } from "../components/BudgetBand";
import { DigestCard } from "../components/DigestCard";
import { Donut } from "../components/Donut";
import { EmptyState } from "../components/EmptyState";
import { ErrorCard } from "../components/ErrorCard";
import { RecentTable } from "../components/RecentTable";
import { RepoFilter } from "../components/RepoFilter";
import { Segmented } from "../components/Segmented";
import { SkeletonCard } from "../components/Skeleton";
import { StatTile } from "../components/StatTile";
import { TokensChart } from "../components/TokensChart";
import { TopBar } from "../components/TopBar";
import { compactTokens, num, signed, usd } from "../lib/format";
import { SEGMENT_OPTIONS } from "../lib/ranges";
import { useApi } from "../lib/useApi";
import { useRange, useRepoFilter } from "../lib/useFilters";
import { useStatus } from "../lib/useLiveRefresh";

const SURFACES: [Surface, string][] = [
	["cli", "CLI"],
	["vscode", "VS Code"],
	["desktop", "desktop"],
	["unknown", "other"],
];

export function Overview() {
	const [range, setRange] = useRange("overview", "7d");
	const [repo, setRepo] = useRepoFilter();
	const status = useStatus();
	const { data, error, loading, reload } = useApi<OverviewData>("/api/overview", { range, repo });

	const top = (
		<TopBar title="Overview">
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
	if (!data || (loading && !data)) {
		return (
			<>
				{top}
				<div className="grid grid-cols-4 gap-4">
					{[0, 1, 2, 3].map((i) => (
						<SkeletonCard key={i} height={96} />
					))}
				</div>
				<SkeletonCard height={260} />
			</>
		);
	}

	const t = data.tiles;
	if (t.sessions.total === 0 && data.recent.length === 0 && status && status.lastIngestAt === null) {
		return (
			<>
				{top}
				<EmptyState />
			</>
		);
	}

	const surfaces = SURFACES.filter(([k]) => t.sessions.bySurface[k] > 0)
		.map(([k, label]) => `${num(t.sessions.bySurface[k])} ${label}`)
		.join(" · ");
	const byModel = t.cost.byModel.map((m) => `${m.label} ${usd(m.usd)}`).join(" · ");
	const unpriced = t.cost.unknownModelTokens > 0 ? `${compactTokens(t.cost.unknownModelTokens)} tokens unpriced` : "";

	return (
		<>
			{top}
			{error ? <ErrorCard error={error} onRetry={reload} /> : null}
			<BudgetBand budget={data.budget} />
			<div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
				<StatTile label="Sessions" value={num(t.sessions.total)} sub={surfaces || "none in this range"} />
				<StatTile
					label="Tokens"
					value={compactTokens(t.tokens.total)}
					sub={`${t.tokens.cacheServedPct}% served from cache`}
				/>
				<StatTile
					label="Est. cost"
					value={usd(t.cost.usd)}
					sub={[byModel, unpriced].filter(Boolean).join(" · ") || "no priced usage"}
				/>
				<StatTile
					label="Code changed"
					value={
						<>
							<span className="text-good">{signed(t.lines.added, "+")}</span>{" "}
							<span className="text-bad">{signed(t.lines.removed, "-")}</span>
						</>
					}
					sub={`${num(t.lines.files)} files across ${num(t.lines.repos)} repos`}
				/>
			</div>
			<div className="grid grid-cols-1 gap-4 md:grid-cols-2">
				<Donut
					title="Cost by model"
					center={`${t.cost.byModel.length} ${t.cost.byModel.length === 1 ? "model" : "models"}`}
					slices={t.cost.byModel.map((m) => ({ label: m.label, value: m.usd, text: usd(m.usd) }))}
				/>
				<Donut
					title="Sessions by repo"
					center={`${num(t.sessions.total)} sessions`}
					slices={t.sessions.byRepo.map((r) => ({ label: r.name, value: r.sessions, text: num(r.sessions) }))}
				/>
			</div>
			<div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
				<TokensChart data={data.tokensPerDay} range={range} note={data.chartNote} />
				<DigestCard range={range} repo={repo} />
			</div>
			{data.recent.length > 0 ? (
				<RecentTable items={data.recent} />
			) : (
				<EmptyState title="No sessions in this range" hint="Try a longer range." command={null} />
			)}
		</>
	);
}

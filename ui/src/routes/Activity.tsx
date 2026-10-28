// Activity (Phase 7 P2, feature 18; mockup Activity.html): streaks, the 365-day heatmap and when sessions start.
// The heatmap always spans the last 365 days (U4); the range select drives the tiles and the hour / weekday charts.
import type { ActivityResponse, Range } from "@api-types";
import { EmptyState } from "../components/EmptyState";
import { ErrorCard } from "../components/ErrorCard";
import { Heatmap } from "../components/Heatmap";
import { HourChart, WeekdayChart } from "../components/HourChart";
import { Segmented } from "../components/Segmented";
import { SkeletonCard } from "../components/Skeleton";
import { StatTile } from "../components/StatTile";
import { TopBar } from "../components/TopBar";
import { num } from "../lib/format";
import { SEGMENT_OPTIONS } from "../lib/ranges";
import { useApi } from "../lib/useApi";
import { useRange } from "../lib/useFilters";

const RANGE_DAYS: Record<Range, number | null> = { today: 1, "7d": 7, "30d": 30, "90d": 90, all: null };
const days = (n: number) => `${num(n)} ${n === 1 ? "day" : "days"}`;

export function Activity() {
	const [range, setRange] = useRange("activity", "30d");
	const { data, error, reload } = useApi<ActivityResponse>("/api/activity", { range });

	const top = (
		<TopBar title="Activity">
			<Segmented label="Date range" value={range} onChange={setRange} options={SEGMENT_OPTIONS} />
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

	const empty = data.days.every((d) => !d.retained);
	const span = RANGE_DAYS[range];
	return (
		<>
			{top}
			{error ? <ErrorCard error={error} onRetry={reload} /> : null}
			<div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
				<StatTile label="Current streak" value={days(data.streak.current)} sub="days in a row with a session" />
				<StatTile label="Longest streak" value={days(data.streak.longest)} sub="in the retained data" />
				<StatTile
					label="Active days"
					value={span === null ? num(data.activeDays) : `${num(data.activeDays)} / ${num(span)}`}
					sub={`${num(data.sessions)} sessions in the range`}
				/>
				<StatTile
					label="Compacted"
					value={`${Math.round(data.compactedShare * 100)}%`}
					sub="of sessions hit a compaction"
				/>
			</div>
			<div className="card flex flex-col gap-2.5 overflow-x-auto px-[18px] py-4">
				<div className="flex items-center gap-3">
					<div className="section-h flex-grow">Last 365 days</div>
					<span className="text-[12px] text-muted">hatched: not retained</span>
				</div>
				{empty ? (
					<EmptyState title="No sessions yet" hint="Run" command="cc-debrief init" />
				) : (
					<Heatmap days={data.days} />
				)}
				{data.truncated ? (
					<p className="m-0 text-[12px] text-muted">
						The heatmap shows the last 365 days; the tiles cover all retained data.
					</p>
				) : null}
			</div>
			<div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
				<HourChart values={data.byHour} />
				<WeekdayChart values={data.byWeekday} />
			</div>
		</>
	);
}

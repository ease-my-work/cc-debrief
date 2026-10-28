// Recap (feature 17 UI; mockup Recap.html): what you worked on for a day, a week or a custom range, grouped by repo or
// by day, ready to copy. URL query: range (yesterday | week | custom), date (a stepped-to day), from / to (custom),
// groupBy=day, files=0. Never calls claude unless "Polish with AI" is clicked.
import type { RecapResponse } from "@api-types";
import { useCallback } from "react";
import { useLocation, useSearch } from "wouter";
import type { Params } from "../api";
import { ErrorCard } from "../components/ErrorCard";
import { RecapCard } from "../components/RecapCard";
import { type RangeChoice, RecapToolbar } from "../components/RecapToolbar";
import { SkeletonCard } from "../components/Skeleton";
import { TopBar } from "../components/TopBar";
import { useApi } from "../lib/useApi";

const pad = (n: number) => String(n).padStart(2, "0");
const localDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const shift = (date: string, days: number) => {
	const [y, m, d] = date.split("-").map(Number);
	return localDate(new Date(y, m - 1, d + days));
};
const DATE = /^\d{4}-\d{2}-\d{2}$/;

type Query = {
	range: string | null;
	date: string | null;
	from: string | null;
	to: string | null;
	groupBy: string | null;
	files: string | null;
};

/** The recap's URL query and a setter that replaces several keys in one history entry. */
function useRecapQuery(): [Query, (patch: Partial<Query>) => void] {
	const search = useSearch();
	const [location, navigate] = useLocation();
	const q = new URLSearchParams(search);
	const query: Query = {
		range: q.get("range"),
		date: q.get("date"),
		from: q.get("from"),
		to: q.get("to"),
		groupBy: q.get("groupBy"),
		files: q.get("files"),
	};
	const update = useCallback(
		(patch: Partial<Query>) => {
			const next = new URLSearchParams(window.location.search);
			for (const [k, v] of Object.entries(patch)) {
				if (v === null || v === undefined || v === "") next.delete(k);
				else next.set(k, v);
			}
			const s = next.toString();
			navigate(s ? `${location}?${s}` : location, { replace: true });
		},
		[location, navigate],
	);
	return [query, update];
}

export function Recap() {
	const [q, update] = useRecapQuery();
	const today = localDate(new Date());
	const yesterday = shift(today, -1);
	const custom = q.range === "custom";
	const date = q.date && DATE.test(q.date) ? q.date : null;
	const named = q.range === "yesterday" || q.range === "week" ? q.range : null;
	const groupBy = q.groupBy === "day" ? "day" : "repo";
	const files = q.files !== "0";
	const from = q.from ?? today;
	const to = q.to ?? today;

	// The range inputs the API takes (GET query and polish body alike).
	const range: Record<string, string> = custom ? { from, to } : date ? { date } : named ? { range: named } : {};
	const params: Params = { ...range, groupBy: groupBy === "day" ? "day" : null, files: files ? null : "0" };
	const { data, error, reload } = useApi<RecapResponse>("/api/recap", params);

	const day = date ?? (named === "yesterday" ? yesterday : named === null && !custom ? today : null);
	const choice: RangeChoice | null = custom
		? "custom"
		: date
			? date === today
				? "today"
				: date === yesterday
					? "yesterday"
					: null
			: (named ?? "today");
	const clear = { date: null, from: null, to: null };
	const onChoice = (c: RangeChoice) => {
		if (c === "today") update({ ...clear, range: null });
		else if (c === "custom")
			update({ range: "custom", date: null, from: data?.recap.range.from ?? from, to: data?.recap.range.to ?? to });
		else update({ ...clear, range: c });
	};
	const stepTo = (d: string) => update({ range: null, from: null, to: null, date: d === today ? null : d });

	return (
		<>
			<TopBar title="Recap">
				<RecapToolbar
					choice={choice}
					onChoice={onChoice}
					stepping={
						day
							? {
									onPrev: () => stepTo(shift(day, -1)),
									onNext: () => stepTo(shift(day, 1)),
									nextDisabled: day >= today,
								}
							: null
					}
					custom={
						custom
							? {
									from,
									to,
									onFrom: (v) => DATE.test(v) && update({ from: v }),
									onTo: (v) => DATE.test(v) && update({ to: v }),
								}
							: null
					}
					groupBy={groupBy}
					onGroupBy={(g) => update({ groupBy: g === "day" ? "day" : null })}
					files={files}
					onFiles={(on) => update({ files: on ? null : "0" })}
				/>
			</TopBar>
			{error && !data ? (
				<ErrorCard error={error} onRetry={reload} />
			) : data ? (
				// Keyed by the request, so a polished version never outlives a change of range or options.
				<RecapCard
					key={JSON.stringify(params)}
					data={data}
					polishBody={{ ...(Object.keys(range).length ? range : { range: "today" }), groupBy }}
				/>
			) : (
				<SkeletonCard height={320} />
			)}
		</>
	);
}

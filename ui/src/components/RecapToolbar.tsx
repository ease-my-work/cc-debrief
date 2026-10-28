// Recap top-bar controls (feature 17 UI): Today / Yesterday / Week / Custom, ‹ › day stepping on single-day ranges
// (› disabled on today), By repo / By day, and the Files checkbox. The parent keeps every value in the URL query.
import { Segmented } from "./Segmented";

export type RangeChoice = "today" | "yesterday" | "week" | "custom";

const RANGES: { value: RangeChoice; label: string }[] = [
	{ value: "today", label: "Today" },
	{ value: "yesterday", label: "Yesterday" },
	{ value: "week", label: "Week" },
	{ value: "custom", label: "Custom" },
];
const GROUPS: { value: "repo" | "day"; label: string }[] = [
	{ value: "repo", label: "By repo" },
	{ value: "day", label: "By day" },
];

const chevron = (d: string) => (
	<svg
		width="12"
		height="12"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		strokeWidth="2.5"
		strokeLinecap="round"
		aria-hidden="true"
	>
		<path d={d} />
	</svg>
);
const step =
	"inline-flex h-7 w-7 items-center justify-center rounded-[7px] border border-border bg-panel p-0 text-neutral-text hover:text-ink disabled:opacity-40";

export function RecapToolbar(p: {
	/** The highlighted range segment; null when a stepped-to date is neither today nor yesterday. */
	choice: RangeChoice | null;
	onChoice: (c: RangeChoice) => void;
	/** Day stepping, shown for single-day ranges only. */
	stepping: { onPrev: () => void; onNext: () => void; nextDisabled: boolean } | null;
	custom: { from: string; to: string; onFrom: (v: string) => void; onTo: (v: string) => void } | null;
	groupBy: "repo" | "day";
	onGroupBy: (g: "repo" | "day") => void;
	files: boolean;
	onFiles: (on: boolean) => void;
}) {
	return (
		<>
			<Segmented label="Range" options={RANGES} value={(p.choice ?? "") as RangeChoice} onChange={p.onChoice} />
			{p.custom ? (
				<span className="inline-flex items-center gap-1.5 text-[13px] text-muted">
					<input
						type="date"
						aria-label="From"
						value={p.custom.from}
						onChange={(e) => p.custom?.onFrom(e.target.value)}
						className="rounded-md border border-border bg-panel px-2 py-1 text-[13px] text-ink"
					/>
					–
					<input
						type="date"
						aria-label="To"
						value={p.custom.to}
						onChange={(e) => p.custom?.onTo(e.target.value)}
						className="rounded-md border border-border bg-panel px-2 py-1 text-[13px] text-ink"
					/>
				</span>
			) : null}
			{p.stepping ? (
				<span className="inline-flex gap-1">
					<button type="button" aria-label="Previous day" className={step} onClick={p.stepping.onPrev}>
						{chevron("M15 6l-6 6 6 6")}
					</button>
					<button
						type="button"
						aria-label="Next day"
						className={step}
						onClick={p.stepping.onNext}
						disabled={p.stepping.nextDisabled}
					>
						{chevron("M9 6l6 6-6 6")}
					</button>
				</span>
			) : null}
			<Segmented label="Grouping" options={GROUPS} value={p.groupBy} onChange={p.onGroupBy} />
			<label className="flex items-center gap-1.5 text-[13px] text-neutral-text">
				<input type="checkbox" checked={p.files} onChange={(e) => p.onFiles(e.target.checked)} />
				Files
			</label>
		</>
	);
}

// The Activity heatmap (Phase 7 P2, U4; mockup Activity.html): the last 365 local days in week columns (Sunday on
// top), shaded by sessions started that day; days before the oldest retained session are hatched "not retained".
import type { ActivityResponse } from "@api-types";
import { compactTokens, num } from "../lib/format";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LEVELS = [
	"var(--color-row)",
	"color-mix(in srgb, var(--color-accent) 25%, var(--color-row))",
	"color-mix(in srgb, var(--color-accent) 50%, var(--color-row))",
	"color-mix(in srgb, var(--color-accent) 75%, var(--color-row))",
	"var(--color-accent)",
];
const HATCH = "repeating-linear-gradient(45deg, var(--color-border) 0 2px, transparent 2px 4px)";

const parse = (date: string) => {
	const [y, m, d] = date.split("-").map(Number);
	return new Date(y, m - 1, d);
};
const label = (date: string) => {
	const d = parse(date);
	return `${WEEKDAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${d.getDate()}`;
};

export function Heatmap({ days }: { days: ActivityResponse["days"] }) {
	const max = Math.max(1, ...days.map((d) => d.sessions));
	const level = (n: number) => (n === 0 ? 0 : Math.min(4, Math.ceil((n / max) * 4)));
	// Empty cells before the first day, so each column is one Sunday-to-Saturday week.
	const lead = days.length > 0 ? parse(days[0].date).getDay() : 0;
	return (
		<div
			role="img"
			aria-label="Sessions per day over the last 365 days"
			className="grid w-max grid-flow-col gap-[3px]"
			style={{ gridTemplateRows: "repeat(7, 11px)" }}
		>
			{WEEKDAYS.slice(0, lead).map((w) => (
				<span key={`pad-${w}`} className="h-[11px] w-[11px]" />
			))}
			{days.map((d) => (
				<span
					key={d.date}
					data-date={d.date}
					data-retained={String(d.retained)}
					title={
						d.retained
							? `${label(d.date)} · ${num(d.sessions)} ${d.sessions === 1 ? "session" : "sessions"} · ${compactTokens(d.tokens)} tokens`
							: `${label(d.date)} · not retained`
					}
					className="h-[11px] w-[11px] rounded-[2px]"
					style={{ background: d.retained ? LEVELS[level(d.sessions)] : HATCH }}
				/>
			))}
		</div>
	);
}

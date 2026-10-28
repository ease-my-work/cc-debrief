// Sessions by local hour of day and by weekday (Phase 7 P2): plain bars with a visually hidden table of the counts.
import { num } from "../lib/format";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function Bars({ title, labels, values }: { title: string; labels: string[]; values: number[] }) {
	const max = Math.max(1, ...values);
	const hourly = labels.length > 7;
	return (
		<div className="card flex flex-col gap-2 px-[18px] py-4">
			<div className="section-h">{title}</div>
			<div className="flex h-[120px] items-end gap-1" aria-hidden="true">
				{values.map((v, i) => (
					<div
						key={labels[i]}
						title={`${labels[i]}: ${num(v)}`}
						className="min-h-[2px] flex-1 rounded-t-[3px] bg-accent"
						style={{ height: `${(v / max) * 100}%` }}
					/>
				))}
			</div>
			<div className="flex gap-1 text-[11px] text-muted" aria-hidden="true">
				{labels.map((l, i) => (
					<span key={l} className="flex-1 text-center">
						{hourly && i % 3 !== 0 ? "" : l}
					</span>
				))}
			</div>
			<table className="sr-only" aria-label={title}>
				<tbody>
					<tr>
						<th>{hourly ? "Hour" : "Day"}</th>
						<th>Sessions</th>
					</tr>
					{values.map((v, i) => (
						<tr key={labels[i]}>
							<td>{labels[i]}</td>
							<td>{v}</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

export function HourChart({ values }: { values: number[] }) {
	return <Bars title="Sessions by hour of day" labels={values.map((_, h) => String(h))} values={values} />;
}

export function WeekdayChart({ values }: { values: number[] }) {
	return <Bars title="Sessions by weekday" labels={WEEKDAYS} values={values} />;
}

// Tokens per day (feature 12): stacked input / cache read / output bars, with an aria-label and a visually hidden
// data table of the same numbers.
import type { Overview, Range } from "@api-types";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { compactTokens, num } from "../lib/format";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const SERIES = [
	{ key: "input", label: "Input", color: "var(--color-series-input)" },
	{ key: "cacheRead", label: "Cache read", color: "var(--color-series-cache-read)" },
	{ key: "output", label: "Output", color: "var(--color-series-output)" },
] as const;

/** Weekday ticks for 7 days, "26 Sep" for 30 days, "Today" for today. */
function tick(date: string, range: Range): string {
	if (range === "today") return "Today";
	const [y, m, d] = date.split("-").map(Number);
	const day = new Date(y, m - 1, d);
	return range === "7d" ? WEEKDAYS[day.getDay()] : `${d} ${MONTHS[m - 1]}`;
}

export function TokensChart({
	data,
	range,
	note,
}: {
	data: Overview["tokensPerDay"];
	range: Range;
	note: string | null;
}) {
	const total = data.reduce((n, d) => n + d.input + d.cacheRead + d.output, 0);
	return (
		<div className="card flex flex-col gap-2.5 px-[18px] py-4">
			<div className="flex items-center gap-3.5">
				<div className="section-h flex-grow">Tokens per day</div>
				{SERIES.map((s) => (
					<div key={s.key} className="flex items-center gap-1.5 text-[12px] text-muted">
						<span className="inline-block h-2.5 w-2.5 rounded-[2px]" style={{ background: s.color }} />
						{s.label}
					</div>
				))}
			</div>
			<figure
				className="m-0"
				aria-label={`Tokens per day, ${data.length} days, ${compactTokens(total)} tokens in total`}
			>
				<ResponsiveContainer width="100%" height={220} initialDimension={{ width: 600, height: 220 }}>
					<BarChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
						<CartesianGrid vertical={false} stroke="var(--color-row)" />
						<XAxis
							dataKey="date"
							tickFormatter={(d: string) => tick(d, range)}
							tick={{ fill: "var(--color-muted)", fontSize: 12 }}
							axisLine={false}
							tickLine={false}
							interval="preserveStartEnd"
						/>
						<YAxis
							tickFormatter={(v: number) => compactTokens(v)}
							tick={{ fill: "var(--color-muted)", fontSize: 12 }}
							axisLine={false}
							tickLine={false}
							width={44}
						/>
						<Tooltip
							formatter={(v, name) => [num(Number(v)), SERIES.find((x) => x.key === name)?.label ?? String(name)]}
							labelFormatter={(d) => String(d)}
							contentStyle={{
								background: "var(--color-panel)",
								border: "1px solid var(--color-border)",
								borderRadius: 8,
								color: "var(--color-ink)",
								fontSize: 12,
							}}
						/>
						{SERIES.map((s) => (
							<Bar key={s.key} dataKey={s.key} stackId="t" fill={s.color} isAnimationActive={false} />
						))}
					</BarChart>
				</ResponsiveContainer>
				<table className="sr-only" aria-label="Tokens per day">
					<thead>
						<tr>
							<th>Date</th>
							{SERIES.map((s) => (
								<th key={s.key}>{s.label}</th>
							))}
						</tr>
					</thead>
					<tbody>
						{data.map((d) => (
							<tr key={d.date}>
								<td>{d.date}</td>
								<td>{d.input}</td>
								<td>{d.cacheRead}</td>
								<td>{d.output}</td>
							</tr>
						))}
					</tbody>
				</table>
			</figure>
			{note ? <div className="text-[12px] text-muted">{note}</div> : null}
		</div>
	);
}

// Cost per day stacked by model family (Phase 7 P3; mockup Costs.html), with an aria-label and a visually hidden
// table of the same numbers, like TokensChart.
import type { CostsResponse } from "@api-types";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { usd } from "../lib/format";

const COLORS: Record<string, string> = {
	Opus: "var(--color-series-input)",
	Sonnet: "var(--color-series-cache-read)",
	Haiku: "var(--color-series-output)",
	Fable: "var(--color-warm)",
	Mythos: "var(--color-good)",
};
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const modelColor = (label: string): string => COLORS[label] ?? "var(--color-muted)";

const tick = (date: string) => {
	const [, m, d] = date.split("-").map(Number);
	return `${d} ${MONTHS[m - 1]}`;
};

export function CostChart({
	data,
	truncated,
	beforeUsd = 0,
}: {
	data: CostsResponse["perDay"];
	truncated: boolean;
	beforeUsd?: number;
}) {
	const labels = [...new Set(data.flatMap((d) => Object.keys(d.byModel)))].sort(
		(a, b) => Object.keys(COLORS).indexOf(a) - Object.keys(COLORS).indexOf(b),
	);
	const rows = data.map((d) => ({ date: d.date, ...d.byModel }));
	const total = data.reduce((n, d) => n + Object.values(d.byModel).reduce((a, b) => a + b, 0), 0);
	return (
		<div className="flex flex-col gap-2.5">
			<div className="flex items-center gap-3.5">
				<div className="section-h flex-grow">Cost per day</div>
				{truncated ? (
					<span className="text-[12px] text-muted">
						{beforeUsd > 0
							? `showing the newest 366 days; ${usd(beforeUsd)} before that not shown`
							: "showing the newest 366 days"}
					</span>
				) : null}
				{labels.map((l) => (
					<div key={l} className="flex items-center gap-1.5 text-[12px] text-muted">
						<span className="inline-block h-2.5 w-2.5 rounded-[2px]" style={{ background: modelColor(l) }} />
						{l}
					</div>
				))}
			</div>
			<figure className="m-0" aria-label={`Cost per day, ${data.length} days, ${usd(total)} in total`}>
				<ResponsiveContainer width="100%" height={200} initialDimension={{ width: 600, height: 200 }}>
					<BarChart data={rows} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
						<CartesianGrid vertical={false} stroke="var(--color-row)" />
						<XAxis
							dataKey="date"
							tickFormatter={tick}
							tick={{ fill: "var(--color-muted)", fontSize: 12 }}
							axisLine={false}
							tickLine={false}
							interval="preserveStartEnd"
						/>
						<YAxis
							tickFormatter={(v: number) => `$${v}`}
							tick={{ fill: "var(--color-muted)", fontSize: 12 }}
							axisLine={false}
							tickLine={false}
							width={44}
						/>
						<Tooltip
							formatter={(v, name) => [usd(Number(v)), String(name)]}
							contentStyle={{
								background: "var(--color-panel)",
								border: "1px solid var(--color-border)",
								borderRadius: 8,
								color: "var(--color-ink)",
								fontSize: 12,
							}}
						/>
						{labels.map((l) => (
							<Bar key={l} dataKey={l} stackId="c" fill={modelColor(l)} isAnimationActive={false} />
						))}
					</BarChart>
				</ResponsiveContainer>
				<table className="sr-only" aria-label="Cost per day">
					<thead>
						<tr>
							<th>Date</th>
							{labels.map((l) => (
								<th key={l}>{l}</th>
							))}
						</tr>
					</thead>
					<tbody>
						{data.map((d) => (
							<tr key={d.date}>
								<td>{d.date}</td>
								{labels.map((l) => (
									<td key={l}>{usd(d.byModel[l] ?? 0)}</td>
								))}
							</tr>
						))}
					</tbody>
				</table>
			</figure>
		</div>
	);
}

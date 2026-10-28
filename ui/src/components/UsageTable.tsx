// "Tracker usage" (feature 15): the package's own claude -p calls per feature for 7 or 30 days.
import type { AiFeature, SelfUsage } from "@api-types";
import { useState } from "react";
import { compactTokens, num, usd } from "../lib/format";
import { useApi } from "../lib/useApi";
import { Segmented } from "./Segmented";

const LABEL: Record<AiFeature, string> = { summary: "Summaries", review: "Reviews", draft: "Drafts", recap: "Recaps" };
const pct = (v: number | null) => (v === null ? "—" : `${v.toFixed(1)}%`);

export function UsageTable() {
	const [range, setRange] = useState<"7d" | "30d">("7d");
	const { data } = useApi<SelfUsage>("/api/self-usage", { range });
	// Recaps arrive in Phase 6: shown once there are any.
	const rows = data?.byFeature.filter((f) => f.feature !== "recap" || f.calls > 0) ?? [];
	return (
		<section className="card overflow-hidden" aria-labelledby="usage-h">
			<div className="flex items-center gap-3 px-4 pt-3.5 pb-2">
				<h2 id="usage-h" className="section-h m-0 flex-grow">
					Tracker usage
				</h2>
				<Segmented
					label="Usage range"
					value={range}
					onChange={setRange}
					options={[
						{ value: "7d", label: "7 days" },
						{ value: "30d", label: "30 days" },
					]}
				/>
			</div>
			<table className="data-table" aria-label="Tracker usage">
				<thead>
					<tr>
						<th>Feature</th>
						<th className="num">Calls</th>
						<th className="num">Failed</th>
						<th className="num">Tokens</th>
						<th className="num">Cache read</th>
						<th className="num">USD</th>
						<th className="num">Share of your usage</th>
					</tr>
				</thead>
				<tbody>
					{rows.map((f) => (
						<tr key={f.feature}>
							<td>{LABEL[f.feature]}</td>
							<td className="num">{num(f.calls)}</td>
							<td className="num">{num(f.failed)}</td>
							<td className="num">{compactTokens(f.tokens)}</td>
							<td className="num">{compactTokens(f.cacheReadTokens)}</td>
							<td className="num">{usd(f.usd)}</td>
							<td className="num">{pct(f.sharePct)}</td>
						</tr>
					))}
					{data ? (
						<tr className="bg-band font-semibold">
							<td>Total</td>
							<td className="num">{num(data.total.calls)}</td>
							<td className="num">{num(data.total.failed)}</td>
							<td className="num">{compactTokens(data.total.tokens)}</td>
							<td className="num">{compactTokens(data.byFeature.reduce((n, f) => n + f.cacheReadTokens, 0))}</td>
							<td className="num">{usd(data.total.usd)}</td>
							<td className="num">{pct(data.total.sharePct)}</td>
						</tr>
					) : null}
				</tbody>
			</table>
			<p className="m-0 border-t border-row px-4 pt-2.5 pb-3.5 text-[12px] text-muted">
				Tracker costs are each call's own tokens at list price; your usage is estimated from the bundled price table.
			</p>
		</section>
	);
}

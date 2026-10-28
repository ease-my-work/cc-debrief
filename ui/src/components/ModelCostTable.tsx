// Per-model tokens and cost (Phase 7 P3): models not in the price table are counted and marked "not priced".
import type { CostsResponse } from "@api-types";
import { compactTokens, usd } from "../lib/format";

const th = "px-3 py-2 text-left text-[12px] font-semibold text-muted";
const td = "mono border-t border-row px-3 py-2.5 text-right";

export function ModelCostTable({ models }: { models: CostsResponse["models"] }) {
	return (
		<div className="card overflow-x-auto">
			<div className="section-h px-4 pt-3.5 pb-1">By model</div>
			<table className="w-full text-[13.5px]" aria-label="Cost by model">
				<thead>
					<tr>
						<th className={th}>Model</th>
						<th className={`${th} text-right`}>Input</th>
						<th className={`${th} text-right`}>Cache write</th>
						<th className={`${th} text-right`}>Cache read</th>
						<th className={`${th} text-right`}>Output</th>
						<th className={`${th} text-right`}>Cost</th>
					</tr>
				</thead>
				<tbody>
					{models.map((m) => (
						<tr key={m.model}>
							<td className="mono border-t border-row px-3 py-2.5">{m.model}</td>
							<td className={td}>{compactTokens(m.input)}</td>
							<td className={td}>{compactTokens(m.cacheWrite)}</td>
							<td className={td}>{compactTokens(m.cacheRead)}</td>
							<td className={td}>{compactTokens(m.output)}</td>
							<td className={`${td} ${m.usd === null ? "text-muted" : ""}`}>
								{m.usd === null ? "not priced" : usd(m.usd)}
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

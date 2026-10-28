import type { SessionListItem } from "@api-types";
import { Link, useLocation } from "wouter";
import { tokenText, usd, when } from "../lib/format";
import { TypeBadge } from "./TypeBadge";

/** Recent sessions: When, Repo, Type, Summary, Tokens, Cost; a row opens the session. */
export function RecentTable({ items }: { items: SessionListItem[] }) {
	const [, navigate] = useLocation();
	return (
		<div className="card flex flex-col overflow-hidden">
			<div className="flex items-center px-4 pt-3.5 pb-1.5">
				<div className="section-h flex-grow">Recent sessions</div>
				<Link href="/sessions" className="text-[12.5px] font-medium no-underline">
					All sessions
				</Link>
			</div>
			<table className="data-table">
				<thead>
					<tr>
						<th className="w-[90px]">When</th>
						<th className="w-[140px]">Repo</th>
						<th className="w-[96px]">Type</th>
						<th>Summary</th>
						<th className="num w-[80px]">Tokens</th>
						<th className="num w-[70px]">Cost</th>
					</tr>
				</thead>
				<tbody>
					{items.map((s) => (
						<tr key={s.id} className="cursor-pointer hover:bg-background" onClick={() => navigate(`/sessions/${s.id}`)}>
							<td className="text-muted">{when(s.startedAt)}</td>
							<td className="mono">{s.repo?.name ?? "—"}</td>
							<td>
								<TypeBadge type={s.type} source={s.typeSource} />
							</td>
							<td>
								{/* The link handles its own click (and Ctrl-click); the row click covers the rest of the row. */}
								<Link href={`/sessions/${s.id}`} className="text-ink no-underline" onClick={(e) => e.stopPropagation()}>
									{s.summaryLine ?? "—"}
								</Link>
								{s.inProgress ? <span className="badge ml-2 bg-accent-fill text-accent">In progress</span> : null}
							</td>
							<td className="num">{tokenText(s)}</td>
							<td className="num">{usd(s.costUsd)}</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

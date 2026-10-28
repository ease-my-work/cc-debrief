// Repo detail trends (Phase 7 P9; mockup note in TasksPlans.html): languages by lines changed, branches, the skills /
// MCP servers / subagent types the sessions used, top tools, and sessions and cost per week (weeks start Monday).
import type { RepoDetail } from "@api-types";
import { num, usd } from "../lib/format";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const weekLabel = (date: string) => {
	const [, m, d] = date.split("-").map(Number);
	return `${d} ${MONTHS[m - 1]}`;
};

function Chips({ title, items }: { title: string; items: { name: string; count: number }[] }) {
	return (
		<div>
			<div className="mb-1 text-[12px] text-muted">{title}</div>
			{items.length === 0 ? (
				<span className="text-[12.5px] text-muted">none</span>
			) : (
				<div className="flex flex-wrap gap-1.5">
					{items.map((i) => (
						<span key={i.name} className="mono rounded-md bg-neutral-fill px-2 py-0.5 text-[12px] text-neutral-text">
							{i.name} ×{num(i.count)}
						</span>
					))}
				</div>
			)}
		</div>
	);
}

export function RepoTrends({ d }: { d: RepoDetail }) {
	const totalLines = d.languages.reduce((n, l) => n + l.lines, 0);
	const maxWeek = Math.max(1, ...d.perWeek.map((w) => w.sessions));
	return (
		<section aria-label="Repo trends" className="card grid grid-cols-1 gap-5 px-[18px] py-4 lg:grid-cols-3">
			<div className="flex flex-col gap-3">
				<div className="section-h">Languages</div>
				{d.languages.length === 0 ? <span className="text-[12.5px] text-muted">no edits in this range</span> : null}
				{d.languages.slice(0, 6).map((l) => {
					const pct = totalLines > 0 ? Math.round((l.lines / totalLines) * 100) : 0;
					return (
						<div key={l.language} className="flex items-center gap-2 text-[12.5px]">
							<span className="mono w-[90px] truncate">{l.language}</span>
							<span className="h-2 flex-grow overflow-hidden rounded bg-row">
								<span className="block h-full bg-accent" style={{ width: `${pct}%` }} />
							</span>
							<span className="mono w-[36px] text-right text-muted">{pct}%</span>
						</div>
					);
				})}
				<div className="section-h mt-2">Branches</div>
				<ul className="m-0 flex list-none flex-col gap-1 p-0 text-[12.5px]">
					{d.branches.slice(0, 6).map((b) => (
						<li key={b.name} className="flex gap-2">
							<span className="mono min-w-0 flex-grow truncate">{b.name}</span>
							<span className="text-muted">{num(b.sessions)}</span>
						</li>
					))}
				</ul>
			</div>
			<div className="flex flex-col gap-3">
				<div className="section-h">Used here</div>
				<Chips title="Skills" items={d.used.skills} />
				<Chips title="MCP servers" items={d.used.mcpServers} />
				<Chips title="Subagent types" items={d.used.agentTypes} />
				<div className="section-h mt-2">Top tools</div>
				<ul className="m-0 flex list-none flex-col gap-1 p-0 text-[12.5px]">
					{d.topTools.map((t) => (
						<li key={t.name} className="flex gap-2">
							<span className="mono min-w-0 flex-grow">{t.name}</span>
							<span className="text-muted">{num(t.calls)}</span>
						</li>
					))}
				</ul>
			</div>
			<div className="flex flex-col gap-2">
				<div className="section-h">Per week</div>
				<div className="flex h-[110px] items-end gap-1" aria-hidden="true">
					{d.perWeek.map((w) => (
						<div
							key={w.week}
							title={`${weekLabel(w.week)}: ${num(w.sessions)} sessions · ${usd(w.usd)}`}
							className="min-h-[2px] flex-1 rounded-t-[3px] bg-accent"
							style={{ height: `${(w.sessions / maxWeek) * 100}%` }}
						/>
					))}
				</div>
				<table className="sr-only" aria-label="Sessions and cost per week">
					<tbody>
						<tr>
							<th>Week of</th>
							<th>Sessions</th>
							<th>Cost</th>
						</tr>
						{d.perWeek.map((w) => (
							<tr key={w.week}>
								<td>{w.week}</td>
								<td>{w.sessions}</td>
								<td>{usd(w.usd)}</td>
							</tr>
						))}
					</tbody>
				</table>
				<div className="text-[12px] text-muted">
					{d.perWeek.length > 0 ? `weeks from ${weekLabel(d.perWeek[0].week)}, starting Monday` : ""}
				</div>
			</div>
		</section>
	);
}

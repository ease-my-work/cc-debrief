// Feature adoption and Claude Code versions (Phase 7 P10, feature 03): the share of the range's sessions that used
// plan mode, subagents, skills, MCP, web tools and auto mode; every version seen with first and last date.
import type { AdoptionRow, VersionRow } from "@api-types";
import { dayLabel, num } from "../lib/format";

const FEATURE_LABEL: Record<AdoptionRow["feature"], string> = {
	plan_mode: "Plan mode",
	subagents: "Subagents",
	skills: "Skills",
	mcp: "MCP",
	web: "Web tools",
	auto_mode: "Auto mode",
};

export function AdoptionTable({ rows }: { rows: AdoptionRow[] }) {
	return (
		<div className="card overflow-hidden">
			<div className="section-h px-4 pt-3.5 pb-1.5">Feature adoption · share of sessions</div>
			<table className="data-table" aria-label="Feature adoption">
				<thead>
					<tr>
						<th>Feature</th>
						<th className="num">Sessions</th>
						<th className="num">Share</th>
					</tr>
				</thead>
				<tbody>
					{rows.map((r) => (
						<tr key={r.feature}>
							<td>{FEATURE_LABEL[r.feature]}</td>
							<td className="num">{num(r.sessions)}</td>
							<td className="num">
								<span className="inline-flex items-center gap-2">
									<span aria-hidden="true" className="inline-block h-1.5 w-[60px] overflow-hidden rounded bg-row">
										<span className="block h-full bg-accent" style={{ width: `${Math.round(r.share * 100)}%` }} />
									</span>
									{Math.round(r.share * 100)}%
								</span>
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

export function VersionTable({ versions }: { versions: VersionRow[] }) {
	return (
		<div className="card overflow-hidden">
			<div className="section-h px-4 pt-3.5 pb-1.5">Claude Code versions</div>
			{versions.length === 0 ? (
				<p className="m-0 px-4 pb-4 text-[13px] text-muted">No version recorded yet.</p>
			) : (
				<table className="data-table" aria-label="Claude Code versions">
					<thead>
						<tr>
							<th>Version</th>
							<th>First seen</th>
							<th>Last seen</th>
							<th className="num">Sessions</th>
						</tr>
					</thead>
					<tbody>
						{versions.map((v) => (
							<tr key={v.version}>
								<td className="mono">{v.version}</td>
								<td className="text-muted">{dayLabel(v.firstSeen)}</td>
								<td className="text-muted">{dayLabel(v.lastSeen)}</td>
								<td className="num">{num(v.sessions)}</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
		</div>
	);
}

import type { RepoDetail } from "@api-types";
import { num } from "../lib/format";

type Item = RepoDetail["items"][number];

function source(i: Item): string {
	if (i.kind === "skill") return `${i.source}${i.lazy ? " (lazy)" : ""}`;
	if (i.kind === "mcp") return i.tools ? `${i.source} · ${num(i.tools)} tools` : i.source;
	return i.source;
}

function Badge({ i }: { i: Item }) {
	if (i.kind === "instructions")
		return <span className="badge bg-neutral-fill text-neutral-text">loaded {num(i.loaded ?? 0)}×</span>;
	if (i.kind === "mcp")
		return i.calls ? (
			<span className="badge bg-good-fill text-good">{num(i.calls)} calls</span>
		) : (
			<span className="badge bg-bad-fill text-bad">never</span>
		);
	return i.invoked ? (
		<span className="badge bg-good-fill text-good">{num(i.invoked)} invoked</span>
	) : (
		<span className="badge bg-bad-fill text-bad">never</span>
	);
}

/** "Repo-level skills & MCP" panel (feature 12). */
export function RepoItems({ d }: { d: RepoDetail }) {
	return (
		<div className="card flex flex-col gap-1 px-[18px] py-4">
			<div className="section-h">Repo-level skills &amp; MCP</div>
			<div className="mb-1.5 text-[12px] text-muted">
				From <span className="mono">.claude/skills</span>, <span className="mono">.mcp.json</span> and{" "}
				<span className="mono">.claude/settings.json</span>
			</div>
			{d.items.length === 0 ? (
				<p className="m-0 text-[13px] text-muted">No repo-level skills, MCP servers or CLAUDE.md.</p>
			) : null}
			{d.items.map((i) => (
				<div key={`${i.kind}-${i.name}`} className="flex items-center justify-between gap-3 py-1">
					<span className="min-w-0">
						<span className="mono text-[13px]">{i.name}</span>
						<div className="truncate text-[12px] text-muted">{source(i)}</div>
					</span>
					<Badge i={i} />
				</div>
			))}
		</div>
	);
}

import type { RepoRow } from "@api-types";
import { compactTokens, num, signed, usd } from "../lib/format";

/** https://github.com/org/repo.git, git@github.com:org/repo.git, github.com:org/repo.git → github.com/org/repo */
export function remoteLabel(url: string | null): string {
	if (!url) return "no remote";
	const hasScheme = /^[a-z+]+:\/\//i.test(url);
	let s = url.replace(/^[a-z+]+:\/\//i, "").replace(/^[^@/]+@/, "");
	if (!hasScheme) s = s.replace(/^([^/:]+):/, "$1/"); // scp-style host:path
	return s.replace(/\.git$/, "");
}

function SkillsBar({ used, of }: { used: number; of: number }) {
	const pct = of > 0 ? Math.round((used / of) * 100) : 0;
	return (
		<div className="flex items-center gap-2">
			<div className="h-1.5 w-16 overflow-hidden rounded-full bg-neutral-fill">
				<div className="h-full bg-accent" style={{ width: `${pct}%` }} />
			</div>
			<span className="mono text-[12.5px]">
				{used} / {of}
			</span>
		</div>
	);
}

/** Repo table (feature 12): selecting a row opens its panels. */
export function RepoTable({
	repos,
	selected,
	onSelect,
}: {
	repos: RepoRow[];
	selected: string | null;
	onSelect: (id: string) => void;
}) {
	return (
		<div className="card overflow-hidden">
			<table className="data-table" aria-label="Repos">
				<thead>
					<tr>
						<th>Repo</th>
						<th>Remote</th>
						<th className="num">Sessions</th>
						<th className="num">Tokens</th>
						<th className="num">Cost</th>
						<th className="num">Lines</th>
						<th>Repo skills used</th>
						<th>Repo MCP</th>
					</tr>
				</thead>
				<tbody>
					{repos.map((r) => (
						<tr
							key={r.id}
							aria-current={r.id === selected ? "true" : undefined}
							tabIndex={0}
							data-nav-item=""
							onClick={() => onSelect(r.id)}
							onKeyDown={(e) => {
								if (e.key !== "Enter" && e.key !== " ") return;
								e.preventDefault(); // Space would also scroll the page
								onSelect(r.id);
							}}
							className={`cursor-pointer ${r.id === selected ? "bg-accent-fill" : "hover:bg-background"}`}
						>
							<td>
								<span className="mono">{r.name}</span>
								<div className="text-[12px] text-muted">
									{r.branch ?? "—"}
									{r.branchesSeen > 1 ? ` · ${r.branchesSeen} branches seen` : ""}
								</div>
							</td>
							<td className="mono text-[12.5px]">{remoteLabel(r.remoteUrl)}</td>
							<td className="num">{num(r.sessions)}</td>
							<td className="num">{compactTokens(r.tokens)}</td>
							<td className="num">{usd(r.costUsd)}</td>
							<td className="num">
								<span className="text-good">{signed(r.linesAdded, "+")}</span>{" "}
								<span className="text-bad">{signed(r.linesRemoved, "-")}</span>
							</td>
							<td>
								<SkillsBar used={r.repoSkillsUsed} of={r.repoSkillsAvailable} />
							</td>
							<td className="mono text-[12.5px]">{r.repoMcp.length ? r.repoMcp.join(", ") : "—"}</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

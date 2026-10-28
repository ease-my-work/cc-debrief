// Skills & Tools (feature 12; mockup SkillsTools.html): tabs Skills / MCP servers / Built-in tools / Plugins &
// hooks, range and repo filters, the summary strip, the tab's table and "Show unused only"; the Skills tab also has
// "Skills proposed from repeated work" (Phase 5b).
import type { AdoptionResponse, InventoryResponse, ToolStat, ToolsResponse, VersionsResponse } from "@api-types";
import { useState } from "react";
import { AdoptionTable, VersionTable } from "../components/AdoptionTable";
import { EmptyState } from "../components/EmptyState";
import { ErrorCard } from "../components/ErrorCard";
import { CATEGORY_LABEL, McpTable, PluginsHooksTable, SkillsTable, ToolsTable } from "../components/InventoryTable";
import { ProposedSkillsTable } from "../components/ProposedSkillsTable";
import { RangeSelect } from "../components/RangeSelect";
import { RepoFilter } from "../components/RepoFilter";
import { SkeletonCard } from "../components/Skeleton";
import { SummaryStrip } from "../components/SummaryStrip";
import { TopBar } from "../components/TopBar";
import { WORKSPACE_KINDS, WorkspaceTable } from "../components/WorkspaceTable";
import { useApi } from "../lib/useApi";
import { useQueryParam, useRange, useRepoFilter } from "../lib/useFilters";
import { useStatus } from "../lib/useLiveRefresh";

const TABS = [
	{ id: "skills", label: "Skills" },
	{ id: "mcp", label: "MCP servers" },
	{ id: "tools", label: "Built-in tools" },
	{ id: "plugins", label: "Plugins & hooks" },
	{ id: "workspace", label: "Workspace" },
] as const;
type Tab = (typeof TABS)[number]["id"];

const FOOTER =
	"Loaded = discovered at session start (its description is in context). Invoked = the Skill tool ran it. Ctx tokens is an estimate from the SKILL.md description length. Remove opens the file location; nothing is deleted automatically.";

export function SkillsTools() {
	const [tabParam, setTab] = useQueryParam("tab");
	const tab: Tab = TABS.some((t) => t.id === tabParam) ? (tabParam as Tab) : "skills";
	const [range, setRange] = useRange("skills", "30d");
	const [repo, setRepo] = useRepoFilter();
	const [unusedParam, setUnused] = useQueryParam("unused");
	// The Plugins tab has no "Show unused only" box, so the filter never applies there.
	const unused = tab !== "plugins" && unusedParam === "1";
	const status = useStatus();

	const kind = tab === "skills" ? "skill" : tab === "mcp" ? "mcp" : tab === "plugins" ? "plugin" : null; // workspace: below
	const inv = useApi<InventoryResponse>(kind ? "/api/inventory" : null, { kind, range, repo, unused });
	const hooks = useApi<InventoryResponse>(tab === "plugins" ? "/api/inventory" : null, { kind: "hook", range, repo });
	const tools = useApi<ToolsResponse>(tab === "tools" ? "/api/tools" : null, { range, repo });
	const adoption = useApi<AdoptionResponse>(tab === "tools" ? "/api/adoption" : null, { range, repo });
	const versions = useApi<VersionsResponse>(tab === "tools" ? "/api/versions" : null);
	const [category, setCategory] = useState<ToolStat["category"] | null>(null);
	const [wsKind, setWsKind] = useState(WORKSPACE_KINDS[0]);
	const workspace = useApi<InventoryResponse>(tab === "workspace" ? "/api/inventory" : null, {
		kind: wsKind.kind,
		range,
		repo,
	});

	const top = (
		<TopBar title="Skills & Tools">
			<div
				role="tablist"
				aria-label="Kind"
				className="flex gap-1 rounded-lg border border-border bg-panel p-0.5 text-[13px]"
			>
				{TABS.map((t) => (
					<button
						key={t.id}
						type="button"
						role="tab"
						aria-selected={t.id === tab}
						onClick={() => setTab(t.id === "skills" ? null : t.id)}
						className={
							t.id === tab
								? "rounded-md bg-ink px-3 py-1 font-medium text-panel"
								: "rounded-md px-3 py-1 text-muted hover:text-ink"
						}
					>
						{t.label}
					</button>
				))}
			</div>
			<RangeSelect value={range} onChange={setRange} />
			<RepoFilter value={repo} onChange={setRepo} />
		</TopBar>
	);

	// First run: nothing captured yet, so every count would be zero.
	if (status?.lastIngestAt === null) {
		return (
			<>
				{top}
				<EmptyState />
			</>
		);
	}

	if (tab === "workspace") {
		return (
			<>
				{top}
				<div className="card overflow-hidden">
					<div className="flex flex-wrap items-center gap-1.5 px-4 pt-3.5 pb-1.5">
						{WORKSPACE_KINDS.map((k) => (
							<button
								key={k.kind}
								type="button"
								aria-pressed={wsKind.kind === k.kind}
								onClick={() => setWsKind(k)}
								className={`rounded-full border px-2.5 py-0.5 text-[12px] ${wsKind.kind === k.kind ? "border-ink bg-ink text-panel" : "border-border bg-panel text-muted"}`}
							>
								{k.label}
							</button>
						))}
					</div>
					{workspace.error ? (
						<ErrorCard error={workspace.error} onRetry={workspace.reload} />
					) : !workspace.data ? (
						<SkeletonCard height={200} />
					) : workspace.data.items.length > 0 ? (
						<WorkspaceTable label={wsKind.label} items={workspace.data.items} />
					) : (
						<p className="m-0 px-4 pb-4 text-[13px] text-muted">
							No {wsKind.noun} found in ~/.claude, your repos' .claude folders or plugins.
						</p>
					)}
				</div>
			</>
		);
	}

	if (tab === "tools") {
		return (
			<>
				{top}
				<div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
					{adoption.data ? <AdoptionTable rows={adoption.data.rows} /> : null}
					{versions.data ? <VersionTable versions={versions.data.versions} /> : null}
				</div>
				{tools.error ? (
					<ErrorCard error={tools.error} onRetry={tools.reload} />
				) : tools.data ? (
					<div className="card overflow-hidden">
						<div className="flex flex-wrap items-center gap-1.5 px-4 pt-3.5 pb-1.5">
							<div className="section-h mr-2">Built-in tools · sorted by calls</div>
							{[null, ...new Set(tools.data.tools.map((t) => t.category))].map((cat) => (
								<button
									key={cat ?? "all"}
									type="button"
									aria-pressed={category === cat}
									onClick={() => setCategory(cat)}
									className={`rounded-full border px-2.5 py-0.5 text-[12px] ${category === cat ? "border-ink bg-ink text-panel" : "border-border bg-panel text-muted"}`}
								>
									{cat === null ? "All" : CATEGORY_LABEL[cat].charAt(0).toUpperCase() + CATEGORY_LABEL[cat].slice(1)}
								</button>
							))}
						</div>
						{tools.data.tools.length ? (
							<ToolsTable tools={tools.data.tools.filter((t) => category === null || t.category === category)} />
						) : (
							<p className="m-0 px-4 pb-4 text-[13px] text-muted">No tool calls in this range.</p>
						)}
					</div>
				) : (
					<SkeletonCard height={300} />
				)}
			</>
		);
	}

	if (inv.error) {
		return (
			<>
				{top}
				<ErrorCard error={inv.error} onRetry={inv.reload} />
			</>
		);
	}
	const data = inv.data;
	if (!data) {
		return (
			<>
				{top}
				<SkeletonCard height={96} />
				<SkeletonCard height={300} />
			</>
		);
	}
	// Plugins & hooks is empty only when there are no hooks either: hooks show even without any plugin.
	const noHooks = tab !== "plugins" || (hooks.data !== null && hooks.data.items.length === 0);
	// Skills proposed from repeated work still show with nothing installed yet (Phase 5b).
	const noProposed = (data.proposed?.length ?? 0) === 0;
	if (data.strip.installed === 0 && data.items.length === 0 && !unused && noHooks && noProposed) {
		return (
			<>
				{top}
				<EmptyState
					title="Nothing installed found"
					hint="Scan your skills, plugins and MCP servers with"
					command="cc-debrief scan"
				/>
			</>
		);
	}

	const noun: [string, string] =
		tab === "skills" ? ["skill", "skills"] : tab === "mcp" ? ["MCP server", "MCP servers"] : ["plugin", "plugins"];
	const title = tab === "skills" ? "Skills" : tab === "mcp" ? "MCP servers" : "Plugins & hooks";
	return (
		<>
			{top}
			<SummaryStrip strip={data.strip} noun={noun} range={range} contextCost={tab === "skills"} />
			{tab === "skills" && data.proposed && data.proposed.length > 0 ? (
				<ProposedSkillsTable rows={data.proposed} onChanged={inv.reload} />
			) : null}
			<div className="card overflow-hidden">
				<div className="flex items-center gap-3 px-4 pt-3.5 pb-1.5">
					<div className="section-h flex-grow">{title} · sorted by sessions loaded</div>
					{tab !== "plugins" ? (
						<label className="flex items-center gap-2 text-[13px] text-muted">
							<input type="checkbox" checked={unused} onChange={(e) => setUnused(e.target.checked ? "1" : null)} />
							Show unused only
						</label>
					) : null}
				</div>
				{tab === "skills" ? <SkillsTable items={data.items} /> : null}
				{tab === "mcp" ? <McpTable items={data.items} /> : null}
				{tab === "plugins" ? <PluginsHooksTable plugins={data.items} hooks={hooks.data?.items ?? []} /> : null}
				{tab === "plugins" && hooks.error ? <ErrorCard error={hooks.error} onRetry={hooks.reload} /> : null}
				{data.items.length === 0 && tab !== "plugins" ? (
					<p className="m-0 px-4 py-4 text-[13px] text-muted">Nothing unused in this range.</p>
				) : null}
				<p className="m-0 border-t border-row px-4 py-3 text-[12px] text-muted">{FOOTER}</p>
			</div>
		</>
	);
}

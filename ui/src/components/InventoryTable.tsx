// The Skills & Tools tables (feature 12 columns per tab).
import type { InventoryItemRow, ToolStat } from "@api-types";
import { compactTokens, num, when } from "../lib/format";
import { RemovePopover } from "./RemovePopover";
import { StatusBadge } from "./StatusBadge";

const lastUsed = (iso: string | null) => (iso ? when(iso) : "never");
const ms = (v: number | null | undefined) => (v === null || v === undefined ? "—" : num(v));

function NameCell({ name, source }: { name: string; source: string }) {
	return (
		<td>
			<span className="mono">{name}</span>
			<div className="text-[12px] text-muted">{source}</div>
		</td>
	);
}

function Bar({ value, of }: { value: number; of: number }) {
	const pct = of > 0 ? Math.min(100, Math.round((value / of) * 100)) : 0;
	return (
		<div className="h-1.5 w-24 overflow-hidden rounded-full bg-neutral-fill" title={`${pct}%`}>
			<div className="h-full bg-accent" style={{ width: `${pct}%` }} />
		</div>
	);
}

const remove = (i: InventoryItemRow, kind: "skill" | "mcp") =>
	i.id > 0 && i.path ? (
		<RemovePopover target={{ name: i.name, path: i.path, kind, scope: i.scope, source: i.source }} />
	) : null;

export function SkillsTable({ items }: { items: InventoryItemRow[] }) {
	return (
		<table className="data-table">
			<thead>
				<tr>
					<th>Skill</th>
					<th>Scope</th>
					<th className="num">Loaded</th>
					<th className="num">Invoked</th>
					<th>Invoked / loaded</th>
					<th>Last used</th>
					<th className="num">Ctx tokens</th>
					<th>Status</th>
					<th />
				</tr>
			</thead>
			<tbody>
				{items.map((i) => (
					<tr key={i.id}>
						<NameCell name={i.name} source={i.source} />
						<td className="text-[12px] text-muted">{i.scope}</td>
						<td className="num">{num(i.sessionsLoaded)}</td>
						<td className="num">{num(i.sessionsInvoked)}</td>
						<td>
							<Bar value={i.sessionsInvoked} of={i.sessionsLoaded} />
						</td>
						<td className="text-muted">{lastUsed(i.lastUsed)}</td>
						<td className="num">~{compactTokens(i.ctxTokens)}</td>
						<td>
							<StatusBadge status={i.status} removed={i.removed} />
						</td>
						<td className="text-right">{remove(i, "skill")}</td>
					</tr>
				))}
			</tbody>
		</table>
	);
}

export function McpTable({ items }: { items: InventoryItemRow[] }) {
	return (
		<table className="data-table">
			<thead>
				<tr>
					<th>Server</th>
					<th>Scope</th>
					<th className="num">Tools</th>
					<th className="num">Calls</th>
					<th className="num">Failures</th>
					<th className="num">Median ms</th>
					<th>Last used</th>
					<th>Status</th>
					<th />
				</tr>
			</thead>
			<tbody>
				{items.map((i) => (
					<tr key={i.id}>
						<NameCell name={i.name} source={i.source} />
						<td className="text-[12px] text-muted">{i.scope}</td>
						<td className="num">{i.tools ? num(i.tools) : "—"}</td>
						<td className="num">{num(i.calls ?? 0)}</td>
						<td className="num">{num(i.failures ?? 0)}</td>
						<td className="num">{ms(i.medianMs)}</td>
						<td className="text-muted">{lastUsed(i.lastUsed)}</td>
						<td>
							<StatusBadge status={i.status} removed={i.removed} />
						</td>
						<td className="text-right">{remove(i, "mcp")}</td>
					</tr>
				))}
			</tbody>
		</table>
	);
}

/** Tool category names (Phase 7 P10, feature 03). */
export const CATEGORY_LABEL: Record<ToolStat["category"], string> = {
	file_read: "file read",
	file_edit: "file edit",
	search: "search",
	shell: "shell",
	web: "web",
	agents: "agents",
	tasks_plans: "tasks & plans",
	skills: "skills",
	mcp: "MCP",
	other: "other",
};

export function ToolsTable({ tools }: { tools: ToolStat[] }) {
	return (
		<table className="data-table" aria-label="Built-in tools">
			<thead>
				<tr>
					<th>Tool</th>
					<th>Category</th>
					<th className="num">Calls</th>
					<th className="num">Failures</th>
					<th className="num">Denials</th>
					<th className="num">Median ms</th>
					<th className="num">Sessions</th>
					<th>Last used</th>
				</tr>
			</thead>
			<tbody>
				{tools.map((t) => (
					<tr key={t.name}>
						<td className="mono">{t.name}</td>
						<td className="text-muted">{CATEGORY_LABEL[t.category]}</td>
						<td className="num">{num(t.calls)}</td>
						<td className="num">{num(t.failures)}</td>
						<td className="num">{num(t.denials)}</td>
						<td className="num">{ms(t.medianMs)}</td>
						<td className="num">{num(t.sessions)}</td>
						<td className="text-muted">{lastUsed(t.lastUsed)}</td>
					</tr>
				))}
			</tbody>
		</table>
	);
}

export function PluginsHooksTable({ plugins, hooks }: { plugins: InventoryItemRow[]; hooks: InventoryItemRow[] }) {
	const rows = [
		...plugins.map((i) => ({ i, kind: "plugin" as const })),
		...hooks.map((i) => ({ i, kind: "hook" as const })),
	];
	return (
		<table className="data-table">
			<thead>
				<tr>
					<th>Name</th>
					<th>Kind</th>
					<th>Scope</th>
					<th>Provides</th>
					<th className="num">Sessions loaded</th>
					<th>Status</th>
				</tr>
			</thead>
			<tbody>
				{rows.map(({ i, kind }) => (
					<tr key={`${kind}-${i.id}`}>
						<td>
							<span className="mono break-all">{i.name}</span>
							{kind === "plugin" && i.enabled === false ? <div className="text-[12px] text-muted">disabled</div> : null}
						</td>
						<td className="text-[12px] text-muted">{kind}</td>
						<td className="text-[12px] text-muted">{i.scope}</td>
						<td className="mono text-[12.5px]">{i.provides ?? "—"}</td>
						<td className="num">{kind === "hook" ? "—" : num(i.sessionsLoaded)}</td>
						<td>
							{kind === "hook" ? (
								<span className="text-muted">—</span>
							) : (
								<StatusBadge status={i.status} removed={i.removed} />
							)}
						</td>
					</tr>
				))}
			</tbody>
		</table>
	);
}

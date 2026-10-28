// Skills & Tools "Workspace" tab (Phase 7 P11, feature 05): agents, commands, output styles, rules and workflows from
// the user, repo and plugin .claude/ folders. Agents and commands have usage (subagent type, slash command); the
// others show "usage not recorded".
import type { InventoryKind, InventoryResponse } from "@api-types";
import { num, when } from "../lib/format";
import { StatusBadge } from "./StatusBadge";

const lastUsed = (iso: string | null) => (iso ? when(iso) : "never");

export const WORKSPACE_KINDS: { kind: InventoryKind; label: string; noun: string }[] = [
	{ kind: "agent", label: "Agents", noun: "agents" },
	{ kind: "command", label: "Commands", noun: "commands" },
	{ kind: "output_style", label: "Output styles", noun: "output styles" },
	{ kind: "rule", label: "Rules", noun: "rules" },
	{ kind: "workflow", label: "Workflows", noun: "workflows" },
];

export function WorkspaceTable({ label, items }: { label: string; items: InventoryResponse["items"] }) {
	return (
		<table className="data-table" aria-label={label}>
			<thead>
				<tr>
					<th>Name</th>
					<th>Source</th>
					<th className="num">Sessions invoked</th>
					<th>Last used</th>
					<th>Status</th>
				</tr>
			</thead>
			<tbody>
				{items.map((i) => (
					<tr key={i.id}>
						<td className="mono" title={i.path}>
							{i.name}
						</td>
						<td className="text-muted">{i.source}</td>
						{i.usageRecorded === false ? (
							<td colSpan={3} className="text-muted">
								usage not recorded
							</td>
						) : (
							<>
								<td className="num">{num(i.sessionsInvoked)}</td>
								<td className="text-muted">{lastUsed(i.lastUsed)}</td>
								<td>
									<StatusBadge status={i.status} removed={i.removed} />
								</td>
							</>
						)}
					</tr>
				))}
			</tbody>
		</table>
	);
}

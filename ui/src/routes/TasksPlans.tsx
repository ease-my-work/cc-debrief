// Tasks & plans (Phase 7 P12; mockup TasksPlans.html): tasks from captured TaskCreate / TaskUpdate / TodoWrite calls
// (newest state per task) and ExitPlanMode plans as Markdown, with status filter, search, range and repo, each linked
// to its session.
import type { TasksPlansResponse } from "@api-types";
import { useEffect, useState } from "react";
import { Link } from "wouter";
import { EmptyState } from "../components/EmptyState";
import { ErrorCard } from "../components/ErrorCard";
import { Markdown } from "../components/Markdown";
import { RepoFilter } from "../components/RepoFilter";
import { Segmented } from "../components/Segmented";
import { SkeletonCard } from "../components/Skeleton";
import { TopBar } from "../components/TopBar";
import { when } from "../lib/format";
import { SEGMENT_OPTIONS } from "../lib/ranges";
import { useApi } from "../lib/useApi";
import { useRange, useRepoFilter } from "../lib/useFilters";

const DEBOUNCE_MS = 250;
const STATUS_OPTIONS = [
	{ value: "", label: "All" },
	{ value: "pending", label: "Pending" },
	{ value: "in_progress", label: "In progress" },
	{ value: "completed", label: "Completed" },
];
const BADGE: Record<string, string> = {
	completed: "bg-good-fill text-good",
	in_progress: "bg-accent-fill text-accent",
	pending: "bg-neutral-fill text-neutral-text",
};

function TaskList({ tasks }: { tasks: TasksPlansResponse["tasks"] }) {
	return (
		<table className="data-table" aria-label="Tasks">
			<thead>
				<tr>
					<th>Task</th>
					<th>Status</th>
					<th>Repo</th>
					<th>Updated</th>
					<th>
						<span className="sr-only">Session</span>
					</th>
				</tr>
			</thead>
			<tbody>
				{tasks.map((t) => (
					<tr key={`${t.sessionId}|${t.updatedAt}|${t.subject}`}>
						<td>{t.subject}</td>
						<td>
							<span className={`badge ${BADGE[t.status] ?? BADGE.pending}`}>{t.status.replaceAll("_", " ")}</span>
						</td>
						<td className="mono">{t.repo ?? <span className="text-muted">no repo</span>}</td>
						<td className="text-muted">{t.updatedAt ? when(t.updatedAt) : "—"}</td>
						<td>
							<Link href={`/sessions/${encodeURIComponent(t.sessionId)}`}>open session</Link>
						</td>
					</tr>
				))}
			</tbody>
		</table>
	);
}

function PlanCard({ p }: { p: TasksPlansResponse["plans"][number] }) {
	return (
		<article aria-label={`Plan in ${p.repo ?? "no repo"}`} className="border-t border-row px-4 py-3.5">
			<div className="mb-1.5 text-[12px] text-muted">
				<span className="mono">{p.repo ?? "no repo"}</span> · {p.ts ? when(p.ts) : "—"} ·{" "}
				<Link href={`/sessions/${encodeURIComponent(p.sessionId)}`}>open session</Link>
			</div>
			<Markdown text={p.plan} />
		</article>
	);
}

export function TasksPlans() {
	const [range, setRange] = useRange("tasks", "30d");
	const [repo, setRepo] = useRepoFilter();
	const [status, setStatus] = useState("");
	const [draft, setDraft] = useState("");
	const [q, setQ] = useState("");
	useEffect(() => {
		const t = setTimeout(() => setQ(draft.trim()), DEBOUNCE_MS);
		return () => clearTimeout(t);
	}, [draft]);
	const { data, error, reload } = useApi<TasksPlansResponse>("/api/tasks-plans", {
		range,
		repo,
		status: status || null,
		q: q || null,
	});

	const top = (
		<TopBar title="Tasks & plans">
			<input
				type="search"
				aria-label="Search tasks and plans"
				placeholder="Search subjects and plans"
				value={draft}
				onChange={(e) => setDraft(e.target.value)}
				className="w-[220px] rounded-lg border border-border bg-panel px-3 py-1.5 text-[13px] text-ink"
			/>
			<Segmented label="Status" value={status} onChange={setStatus} options={STATUS_OPTIONS} />
			<Segmented label="Date range" value={range} onChange={setRange} options={SEGMENT_OPTIONS} />
			<RepoFilter value={repo} onChange={setRepo} />
		</TopBar>
	);
	if (error && !data)
		return (
			<>
				{top}
				<ErrorCard error={error} onRetry={reload} />
			</>
		);
	if (!data)
		return (
			<>
				{top}
				<SkeletonCard height={300} />
			</>
		);
	if (data.tasks.length === 0 && data.plans.length === 0)
		return (
			<>
				{top}
				<EmptyState
					title="No tasks or plans in this range"
					hint="They appear when Claude Code uses its task list or plan mode."
					command={null}
				/>
			</>
		);
	return (
		<>
			{top}
			<div className="card overflow-hidden">
				<div className="flex items-center px-4 pt-3.5 pb-1">
					<div className="section-h flex-grow">Tasks</div>
					<span className="text-[12px] text-muted">newest state per task</span>
				</div>
				{data.tasks.length > 0 ? (
					<TaskList tasks={data.tasks} />
				) : (
					<p className="m-0 px-4 pb-4 text-[13px] text-muted">No tasks match.</p>
				)}
			</div>
			<div className="card overflow-hidden">
				<div className="flex items-center px-4 pt-3.5 pb-2">
					<div className="section-h flex-grow">Plans</div>
					<span className="text-[12px] text-muted">from plan mode</span>
				</div>
				{data.plans.length > 0 ? (
					data.plans.map((p) => <PlanCard key={`${p.sessionId}-${p.ts}`} p={p} />)
				) : (
					<p className="m-0 px-4 pb-4 text-[13px] text-muted">No plans match.</p>
				)}
			</div>
		</>
	);
}

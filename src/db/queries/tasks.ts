// GET /api/tasks-plans (Phase 7 P12, spec decision 8): tasks and plans from captured tool calls (the already-redacted
// tool_calls.input), for sessions started in the range (and repo). A task's newest state wins: TaskCreate gives the
// subject (its number from the "Task #N created" response, else the order of creates), TaskUpdate changes status or
// subject; an older Claude Code's TodoWrite replaces the whole list each call. Plans are ExitPlanMode's `plan`.
// No prompt text and no paths: repos by name only.
import { decodePayload } from "../../ingest/line";
import type { Range, TasksPlansResponse } from "../../server/types";
import type { Db } from "../adapter";
import { rangeStart } from "./range";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const CREATED = /Task #(\d+) created/;
const DELETED = "deleted";

type Call = {
	session_id: string;
	tool_name: string;
	input: Uint8Array | null;
	response: Uint8Array | null;
	started_at: string | null;
	repo: string | null;
};

function decode(blob: Uint8Array | null): unknown {
	if (!blob) return null;
	try {
		return decodePayload(blob);
	} catch {
		return null;
	}
}

export function getTasksPlans(
	db: Db,
	opts: { range: Range; repo?: string; status?: string; q?: string; now: Date },
): TasksPlansResponse {
	const calls = db
		.prepare(
			`SELECT t.session_id, t.tool_name, t.input, t.response, t.started_at, r.name AS repo
			 FROM tool_calls t JOIN sessions s ON s.session_id = t.session_id LEFT JOIN repos r ON r.repo_id = s.repo_id
			 WHERE t.tool_name IN ('TaskCreate', 'TaskUpdate', 'TodoWrite', 'ExitPlanMode')
			   AND s.started_at >= ?${opts.repo ? " AND s.repo_id = ?" : ""}
			 ORDER BY t.session_id, t.started_at, t.id`,
		)
		.all<Call>(rangeStart(opts.range, opts.now), ...(opts.repo ? [opts.repo] : []));

	type Task = TasksPlansResponse["tasks"][number];
	const tasks: Task[] = [];
	const plans: TasksPlansResponse["plans"] = [];
	let session: string | null = null;
	let byId = new Map<string, Task>();
	let todo: Task[] = [];
	let creates = 0;
	const flush = () => {
		tasks.push(...byId.values(), ...todo);
		byId = new Map();
		todo = [];
		creates = 0;
	};
	for (const c of calls) {
		if (c.session_id !== session) {
			flush();
			session = c.session_id;
		}
		const input = decode(c.input);
		if (!isObj(input)) continue;
		const at = c.started_at ?? "";
		if (c.tool_name === "ExitPlanMode") {
			const plan = str(input.plan);
			if (plan) plans.push({ sessionId: c.session_id, repo: c.repo, ts: at, plan });
		} else if (c.tool_name === "TaskCreate") {
			creates++;
			const response = decode(c.response);
			const excerpt = isObj(response) && typeof response.excerpt === "string" ? response.excerpt : "";
			const id = CREATED.exec(excerpt)?.[1] ?? String(creates);
			byId.set(id, {
				subject: str(input.subject) ?? "(no subject)",
				status: "pending",
				sessionId: c.session_id,
				repo: c.repo,
				updatedAt: at,
			});
		} else if (c.tool_name === "TaskUpdate") {
			const id = input.taskId === undefined ? null : String(input.taskId);
			const task = id === null ? undefined : byId.get(id);
			if (!task || id === null) continue;
			const status = str(input.status);
			if (status === DELETED) {
				byId.delete(id);
				continue;
			}
			if (status) task.status = status;
			const subject = str(input.subject);
			if (subject) task.subject = subject;
			task.updatedAt = at;
		} else if (c.tool_name === "TodoWrite" && Array.isArray(input.todos)) {
			todo = input.todos.filter(isObj).map((t) => ({
				subject: str(t.content) ?? "(no subject)",
				status: str(t.status) ?? "pending",
				sessionId: c.session_id,
				repo: c.repo,
				updatedAt: at,
			}));
		}
	}
	flush();

	const q = opts.q?.trim().toLowerCase() ?? "";
	const shown = tasks
		.filter((t) => (!opts.status || t.status === opts.status) && (!q || t.subject.toLowerCase().includes(q)))
		// Stable: tasks updated at the same moment keep their list order.
		.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	return {
		tasks: shown,
		plans: plans.filter((p) => !q || p.plan.toLowerCase().includes(q)).sort((a, b) => b.ts.localeCompare(a.ts)),
	};
}

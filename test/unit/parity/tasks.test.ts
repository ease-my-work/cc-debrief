// Phase 7 Task 14 (P12): tasks and plans from captured TaskCreate / TaskUpdate / TodoWrite and ExitPlanMode calls.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../../src/db/adapter";
import { getTasksPlans } from "../../../src/db/queries/tasks";
import { encodePayload } from "../../../src/ingest/line";
import { createApp } from "../../../src/server/app";
import { LEAK_FOLDER, LEAK_PROMPT, localAt, PARITY_NOW, REPO_A, seedParitySession } from "../../helpers/parity-seed";
import { seedDb } from "../../helpers/seed";
import { type TmpHome, tmpHome } from "../../helpers/tmp-home";

let h: TmpHome;
let db: Db;
beforeEach(() => {
	h = tmpHome();
	db = seedDb();
});
afterEach(() => {
	db.close();
	h.cleanup();
});

let n = 0;
function call(session: string, tool: string, input: unknown, at: string, excerpt: string | null = null) {
	db.prepare(
		`INSERT INTO tool_calls (session_id, tool_use_id, tool_name, input, response, started_at, ok)
		 VALUES (?, ?, ?, ?, ?, ?, 1)`,
	).run(
		session,
		`tu-${n++}`,
		tool,
		encodePayload(input),
		excerpt === null ? null : encodePayload({ toolUseResult: null, bytes: excerpt.length, isError: false, excerpt }),
		at,
	);
}

describe("getTasksPlans", () => {
	it("keeps the newest state per task: TaskCreate then TaskUpdate by task id", () => {
		seedParitySession(db, "s1", { startedAt: localAt(1, 9), repo: REPO_A });
		call(
			"s1",
			"TaskCreate",
			{ subject: "Write the migration", description: "d" },
			localAt(1, 9, 1),
			"Task #1 created successfully: Write the migration",
		);
		call("s1", "TaskCreate", { subject: "Add tests" }, localAt(1, 9, 2), "Task #2 created successfully: Add tests");
		call("s1", "TaskUpdate", { taskId: "1", status: "in_progress" }, localAt(1, 9, 3));
		call("s1", "TaskUpdate", { taskId: "1", status: "completed" }, localAt(1, 9, 30));
		call("s1", "TaskUpdate", { taskId: "2", subject: "Add migration tests" }, localAt(1, 9, 31));
		const r = getTasksPlans(db, { range: "7d", now: PARITY_NOW });
		expect(r.tasks).toEqual([
			{ subject: "Add migration tests", status: "pending", sessionId: "s1", repo: "api", updatedAt: localAt(1, 9, 31) },
			{
				subject: "Write the migration",
				status: "completed",
				sessionId: "s1",
				repo: "api",
				updatedAt: localAt(1, 9, 30),
			},
		]);
	});

	it("falls back to the order of TaskCreate calls when the response has no task number, and drops deleted tasks", () => {
		seedParitySession(db, "s1", { startedAt: localAt(1, 9) });
		call("s1", "TaskCreate", { subject: "one" }, localAt(1, 9, 1));
		call("s1", "TaskCreate", { subject: "two" }, localAt(1, 9, 2));
		call("s1", "TaskUpdate", { taskId: "2", status: "deleted" }, localAt(1, 9, 3));
		expect(getTasksPlans(db, { range: "7d", now: PARITY_NOW }).tasks.map((t) => [t.subject, t.status])).toEqual([
			["one", "pending"],
		]);
	});

	it("maps TodoWrite lists (older Claude Code) to the same shape; the newest list wins", () => {
		seedParitySession(db, "s2", { startedAt: localAt(2, 9) });
		call("s2", "TodoWrite", { todos: [{ content: "a", status: "pending", activeForm: "A" }] }, localAt(2, 9, 1));
		call(
			"s2",
			"TodoWrite",
			{
				todos: [
					{ content: "a", status: "completed", activeForm: "A" },
					{ content: "b", status: "in_progress", activeForm: "B" },
				],
			},
			localAt(2, 9, 5),
		);
		expect(getTasksPlans(db, { range: "7d", now: PARITY_NOW }).tasks.map((t) => [t.subject, t.status, t.repo])).toEqual(
			[
				["a", "completed", null],
				["b", "in_progress", null],
			],
		);
	});

	it("lists ExitPlanMode plans newest first, and filters by status and search over subjects and plans", () => {
		seedParitySession(db, "s1", { startedAt: localAt(3, 9), repo: REPO_A });
		call("s1", "ExitPlanMode", { plan: "# Cache plan\n\nUse Redis" }, localAt(3, 9, 10));
		call("s1", "ExitPlanMode", { plan: "# Second plan" }, localAt(3, 9, 20));
		call("s1", "TaskCreate", { subject: "Wire Redis client" }, localAt(3, 9, 21), "Task #1 created successfully: x");
		call("s1", "TaskCreate", { subject: "Docs" }, localAt(3, 9, 22), "Task #2 created successfully: x");
		call("s1", "TaskUpdate", { taskId: "2", status: "completed" }, localAt(3, 9, 23));
		const all = getTasksPlans(db, { range: "7d", now: PARITY_NOW });
		expect(all.plans.map((p) => p.plan)).toEqual(["# Second plan", "# Cache plan\n\nUse Redis"]);
		expect(all.plans[0]).toMatchObject({ sessionId: "s1", repo: "api", ts: localAt(3, 9, 20) });
		const redis = getTasksPlans(db, { range: "7d", now: PARITY_NOW, q: "REDIS" });
		expect(redis.tasks.map((t) => t.subject)).toEqual(["Wire Redis client"]);
		expect(redis.plans.map((p) => p.plan)).toEqual(["# Cache plan\n\nUse Redis"]);
		expect(
			getTasksPlans(db, { range: "7d", now: PARITY_NOW, status: "completed" }).tasks.map((t) => t.subject),
		).toEqual(["Docs"]);
	});

	it("follows the range and repo of the session; stored (redacted) input is shown as stored", () => {
		seedParitySession(db, "old", { startedAt: localAt(40) });
		call("old", "TaskCreate", { subject: "ancient" }, localAt(40, 10, 1));
		seedParitySession(db, "s3", { startedAt: localAt(1), repo: REPO_A });
		call("s3", "TaskCreate", { subject: "rotate [REDACTED:api-key]" }, localAt(1, 10, 1));
		expect(getTasksPlans(db, { range: "30d", now: PARITY_NOW }).tasks.map((t) => t.subject)).toEqual([
			"rotate [REDACTED:api-key]",
		]);
		expect(getTasksPlans(db, { range: "all", now: PARITY_NOW }).tasks).toHaveLength(2);
		expect(getTasksPlans(db, { range: "all", repo: REPO_A.id, now: PARITY_NOW }).tasks).toHaveLength(1);
	});
});

describe("GET /api/tasks-plans", () => {
	it("returns the lists, rejects a bad status, and never carries prompts or the session folder", async () => {
		const at = new Date(Date.now() - 3_600_000).toISOString();
		seedParitySession(db, "s1", { startedAt: at, prompt: LEAK_PROMPT, cwd: `/home/u/${LEAK_FOLDER}/x` });
		call("s1", "TaskCreate", { subject: "visible" }, at);
		const app = createApp(db, { port: 4242, uiDir: "/x" });
		const get = (p: string) => app.request(p, { headers: { host: "localhost:4242" } });
		const r = await get("/api/tasks-plans?range=7d");
		expect(r.status).toBe(200);
		const text = await r.text();
		expect(text).toContain("visible");
		expect(text).not.toContain(LEAK_PROMPT);
		expect(text).not.toContain(LEAK_FOLDER);
		expect((await get("/api/tasks-plans?status=done")).status).toBe(400);
	});
});

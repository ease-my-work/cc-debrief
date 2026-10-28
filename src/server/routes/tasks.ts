// GET /api/tasks-plans (Phase 7 P12): read-only; task subjects and plans from captured tool calls, repo names only.
import type { Hono } from "hono";
import { z } from "zod";
import type { Db } from "../../db/adapter";
import { getTasksPlans } from "../../db/queries/tasks";
import type { TasksPlansResponse } from "../types";
import { parseQuery, RangeParam, RepoParam } from "./params";

const TasksParams = z.object({
	range: RangeParam.default("30d"),
	repo: RepoParam.optional(),
	status: z.enum(["pending", "in_progress", "completed"]).optional(),
	q: z.string().max(200).optional(),
});

export function registerTaskRoutes(app: Hono, db: Db): void {
	app.get("/api/tasks-plans", (c) => {
		const p = parseQuery(c, TasksParams);
		return c.json(getTasksPlans(db, { ...p, now: new Date() }) satisfies TasksPlansResponse);
	});
}

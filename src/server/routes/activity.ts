// GET /api/activity (Phase 7 P2, feature 18): read-only; counts and dates only.
import type { Hono } from "hono";
import { z } from "zod";
import type { Db } from "../../db/adapter";
import { getActivity } from "../../db/queries/activity";
import type { ActivityResponse } from "../types";
import { parseQuery, RangeParam } from "./params";

const ActivityParams = z.object({ range: RangeParam.default("30d") });

export function registerActivityRoutes(app: Hono, db: Db): void {
	app.get("/api/activity", (c) => {
		const p = parseQuery(c, ActivityParams);
		return c.json(getActivity(db, { ...p, now: new Date() }) satisfies ActivityResponse);
	});
}

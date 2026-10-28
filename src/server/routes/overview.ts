// GET /api/status, GET /api/overview (Phase 2); GET /api/improvements (Phase 3 footer, Phase 4 digest items).
import type { Hono } from "hono";
import { z } from "zod";
import { buildDigest } from "../../coach/digest";
import { loadConfig } from "../../config";
import type { Db } from "../../db/adapter";
import { getOverview } from "../../db/queries/overview";
import { getStatus } from "../../db/queries/status";
import type { ImprovementsResponse, Overview, StatusResponse } from "../types";
import { parseQuery, RangeParam, RepoParam } from "./params";

const OverviewParams = z.object({ range: RangeParam.default("7d"), repo: RepoParam.optional() });

export function registerOverviewRoutes(app: Hono, db: Db): void {
	app.get("/api/status", (c) => c.json(getStatus(db) satisfies StatusResponse));
	app.get("/api/overview", (c) => {
		const p = parseQuery(c, OverviewParams);
		return c.json(getOverview(db, { ...p, now: new Date(), cfg: loadConfig() }) satisfies Overview);
	});
	// Items follow range and repo; the footer ignores both (feature 15: always the last 7 days, all repos).
	app.get("/api/improvements", (c) => {
		const p = parseQuery(c, OverviewParams);
		return c.json(buildDigest(db, { ...p, cfg: loadConfig() }) satisfies ImprovementsResponse);
	});
}

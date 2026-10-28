// GET /api/costs (Phase 7 P3 + P6, feature 18): read-only, no prompt text, repo names only.
import type { Hono } from "hono";
import { z } from "zod";
import { loadConfig } from "../../config";
import type { Db } from "../../db/adapter";
import { getCosts } from "../../db/queries/costs";
import type { CostsResponse } from "../types";
import { parseQuery, RangeParam, RepoParam } from "./params";

const CostsParams = z.object({ range: RangeParam.default("30d"), repo: RepoParam.optional() });

export function registerCostRoutes(app: Hono, db: Db): void {
	app.get("/api/costs", (c) => {
		const p = parseQuery(c, CostsParams);
		return c.json(getCosts(db, { ...p, now: new Date(), cfg: loadConfig() }) satisfies CostsResponse);
	});
}

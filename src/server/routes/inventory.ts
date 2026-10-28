// GET /api/inventory, GET /api/tools (Phase 2); kind=skill adds the proposed skills from repeated work (Phase 5b).
import type { Hono } from "hono";
import { z } from "zod";
import { loadConfig } from "../../config";
import type { Db } from "../../db/adapter";
import { getAdoption, getVersions } from "../../db/queries/adoption";
import { getInventory } from "../../db/queries/inventory";
import { getToolStats } from "../../db/queries/tools";
import { proposedSkills } from "../../patterns/views";
import type { AdoptionResponse, InventoryResponse, ToolsResponse, VersionsResponse } from "../types";
import { parseQuery, RangeParam, RepoParam } from "./params";

const InventoryParams = z.object({
	kind: z
		.enum(["skill", "mcp", "plugin", "hook", "agent", "command", "output_style", "rule", "workflow"])
		.default("skill"),
	range: RangeParam.default("30d"),
	repo: RepoParam.optional(),
	unused: z
		.enum(["0", "1", "true", "false"])
		.transform((v) => v === "1" || v === "true")
		.optional(),
});
const ToolsParams = z.object({ range: RangeParam.default("30d"), repo: RepoParam.optional() });

export function registerInventoryRoutes(app: Hono, db: Db): void {
	app.get("/api/inventory", (c) => {
		const p = parseQuery(c, InventoryParams);
		const now = new Date();
		const inventory = getInventory(db, { ...p, now });
		const proposed = p.kind === "skill" ? proposedSkills(db, loadConfig(), now) : undefined;
		return c.json({ ...inventory, ...(proposed ? { proposed } : {}) } satisfies InventoryResponse);
	});
	app.get("/api/tools", (c) => {
		const p = parseQuery(c, ToolsParams);
		return c.json({ tools: getToolStats(db, { ...p, now: new Date() }) } satisfies ToolsResponse);
	});
	// Phase 7 P10: share of sessions using each Claude Code feature; versions seen.
	app.get("/api/adoption", (c) => {
		const p = parseQuery(c, ToolsParams);
		return c.json({ rows: getAdoption(db, { ...p, now: new Date() }) } satisfies AdoptionResponse);
	});
	app.get("/api/versions", (c) => c.json({ versions: getVersions(db) } satisfies VersionsResponse));
}

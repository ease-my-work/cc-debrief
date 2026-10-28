// GET/PUT /api/config, GET /api/config/retention-preview, GET /api/self-usage, POST /api/nudges/* (features 15, 16).
// The Settings page and the CLI write the same sparse config.json through updateConfig().
import { statSync } from "node:fs";
import type { Hono } from "hono";
import { z } from "zod";
import { PRICE_TABLE, PRICE_TABLE_VERSION } from "../../collector/prices";
import { projectsSize } from "../../collector/storage";
import { estimateFeatureCost, estimateSummaryCost, pendingSummaryIds } from "../../collector/summarize";
import { ConfigError, ConfigSchema, configErrors, explicitConfigKeys, loadConfig, updateConfig } from "../../config";
import type { Db } from "../../db/adapter";
import { NUDGES, type NudgeName, nudgeKey } from "../../db/queries/improvements";
import { setMeta } from "../../db/queries/meta";
import { retentionPreview } from "../../db/queries/retention";
import { listDemotedRules } from "../../db/queries/ruleFeedback";
import { aiCallsToday, selfUsageSummary } from "../../db/queries/selfUsage";
import { activePricing } from "../../derive/pricing";
import { configPath, dataDir, dbPath } from "../../paths";
import { DEFAULT_REDACT } from "../../redact";
import { HttpError } from "../errors";
import { getRepriceJob, startRepriceJob } from "../jobs";
import type { ConfigResponse, ConfigUpdateError, ConfigUpdateResponse, RetentionPreview, SelfUsage } from "../types";
import { parseQuery } from "./params";

const PatchBody = z
	.object({
		set: z.record(z.string(), z.unknown()).optional(),
		unset: z.array(z.string()).optional(),
	})
	.strict();

function dbBytes(): number {
	let n = 0;
	for (const suffix of ["", "-wal"]) {
		try {
			n += statSync(dbPath() + suffix).size;
		} catch {
			// not created
		}
	}
	return n;
}

export function getConfigResponse(db: Db): ConfigResponse {
	const config = loadConfig();
	return {
		config,
		defaults: ConfigSchema.parse({}),
		explicit: explicitConfigKeys(),
		path: configPath(),
		errors: configErrors(),
		defaultRedactCount: DEFAULT_REDACT.length,
		demotedRules: listDemotedRules(db),
		usedToday: { summaries: aiCallsToday(db, "summary"), reviews: aiCallsToday(db, "review") },
		pendingSummaries: pendingSummaryIds(db, { capture: "hooks" }).length,
		estimates: {
			summaryUsd: estimateSummaryCost(db, config),
			reviewUsd: estimateFeatureCost(db, config, "review"),
			draftUsd: estimateFeatureCost(db, config, "draft"),
		},
		dataDir: dataDir(),
		dbBytes: dbBytes(),
		storage: (() => {
			const s = projectsSize();
			return { projectsBytes: s.bytes, projectsCut: s.cut };
		})(),
		pricing: {
			tableVersion: PRICE_TABLE_VERSION,
			effectiveVersion: activePricing(config.pricing.overrides).version,
			builtIn: Object.entries(PRICE_TABLE).map(([model, p]) => ({ model, ...p })),
			repricing: getRepriceJob(),
		},
	};
}

const invalid = (message: string, fields: { key: string; message: string }[]): ConfigUpdateError => ({
	error: { code: "invalid_config", message, fields },
});

export function registerConfigRoutes(app: Hono, db: Db): void {
	app.get("/api/config", (c) => c.json(getConfigResponse(db) satisfies ConfigResponse));

	app.put("/api/config", async (c) => {
		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json(invalid("The body is not JSON", []), 422);
		}
		const patch = PatchBody.safeParse(body);
		if (!patch.success) {
			return c.json(invalid("Send { set?: { key: value }, unset?: [key] }", []), 422);
		}
		const keys = [...Object.keys(patch.data.set ?? {}), ...(patch.data.unset ?? [])];
		try {
			// updateConfig re-reads config.json first, so a hand edit to another key since the page loaded is kept.
			const config = updateConfig(patch.data);
			// New prices: re-derive the sessions priced with the old table (feature 02, Phase 7 P7).
			if (keys.some((k) => k === "pricing" || k.startsWith("pricing."))) startRepriceJob(db);
			return c.json({ config, changed: keys } satisfies ConfigUpdateResponse);
		} catch (e) {
			if (e instanceof ConfigError) {
				return c.json(
					invalid(e.message, e.fields.length > 0 ? e.fields : [{ key: keys[0] ?? "", message: e.message }]),
					422,
				);
			}
			throw e;
		}
	});

	app.get("/api/config/retention-preview", (c) => {
		const { days } = parseQuery(c, z.object({ days: z.coerce.number().int().min(0).max(3650) }));
		return c.json({ sessions: retentionPreview(db, days) } satisfies RetentionPreview);
	});

	app.get("/api/self-usage", (c) => {
		const { range } = parseQuery(c, z.object({ range: z.enum(["7d", "30d"]).default("7d") }));
		return c.json(selfUsageSummary(db, range) satisfies SelfUsage);
	});

	app.post("/api/nudges/reset", (c) => {
		db.prepare("DELETE FROM meta WHERE key LIKE 'nudge.%'").run();
		return c.json({ ok: true });
	});

	app.post("/api/nudges/:name/dismiss", (c) => {
		const name = c.req.param("name");
		if (!NUDGES.includes(name as NudgeName)) throw new HttpError(404, "not_found", `No nudge ${name}`);
		setMeta(db, nudgeKey(name as NudgeName), new Date().toISOString());
		return c.json({ ok: true });
	});
}

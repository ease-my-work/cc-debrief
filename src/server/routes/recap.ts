// GET /api/recap and POST /api/recap/polish (feature 17 API; Phase 6 plan Task 9). GET never calls claude; polish is one
// call at a time in this process (409 polish_in_flight) and maps a PolishError to 502 polish_failed with its reason.
import type { Context, Hono } from "hono";
import { z } from "zod";
import { loadConfig } from "../../config";
import type { Db } from "../../db/adapter";
import { buildRecap } from "../../recap/build";
import { formatMarkdown, formatRepo, formatText } from "../../recap/format";
import { estimatePolishCost, PolishError, polishRecap } from "../../recap/polish";
import { RecapRangeError, resolveRange } from "../../recap/range";
import type { Recap, RecapRange } from "../../recap/types";
import { HttpError } from "../errors";
import type { RecapPolishResponse, RecapResponse } from "../types";
import { parseQuery } from "./params";

const DateParam = z.string().max(20);
const RangeFields = {
	range: z.enum(["today", "yesterday", "week"]).optional(),
	date: DateParam.optional(),
	from: DateParam.optional(),
	to: DateParam.optional(),
	groupBy: z.enum(["repo", "day"]).default("repo"),
};
const GetParams = z.object({ ...RangeFields, files: z.enum(["1", "0"]).default("1") });
const PolishBody = z.object(RangeFields);

function rangeOf(p: { range?: "today" | "yesterday" | "week"; date?: string; from?: string; to?: string }): RecapRange {
	try {
		return resolveRange(p);
	} catch (e) {
		if (e instanceof RecapRangeError) throw new HttpError(400, "invalid_range", e.message);
		throw e;
	}
}

/** Per-repo copy text, keyed by repo label, in the order the recap shows them. */
function repoText(r: Recap): RecapResponse["repoText"] {
	const labels = [...new Set((r.groupBy === "day" ? r.days.flatMap((d) => d.groups) : r.groups).map((g) => g.repo))];
	return Object.fromEntries(
		labels.map((repo) => [repo, { text: formatRepo(r, repo, "text"), markdown: formatRepo(r, repo, "markdown") }]),
	);
}

async function jsonBody(c: Context): Promise<z.infer<typeof PolishBody>> {
	const r = PolishBody.safeParse((await c.req.json().catch(() => ({}))) ?? {});
	if (!r.success) throw new HttpError(400, "bad_request", `Invalid body: ${r.error.issues[0]?.message ?? "bad value"}`);
	return r.data;
}

export function registerRecapRoutes(app: Hono, db: Db): void {
	let polishing = false;

	app.get("/api/recap", (c) => {
		const p = parseQuery(c, GetParams);
		const range = rangeOf(p);
		const cfg = loadConfig();
		const recap = buildRecap(db, cfg, { range, groupBy: p.groupBy, files: p.files === "1" });
		return c.json({
			recap,
			text: formatText(recap),
			markdown: formatMarkdown(recap),
			repoText: repoText(recap),
			polishEstUsd: recap.sessions > 0 ? estimatePolishCost(db, recap, cfg) : null,
		} satisfies RecapResponse);
	});

	app.post("/api/recap/polish", async (c) => {
		const p = await jsonBody(c);
		const range = rangeOf(p);
		if (polishing) throw new HttpError(409, "polish_in_flight", "A polish is already running");
		polishing = true;
		try {
			const cfg = loadConfig();
			const recap = buildRecap(db, cfg, { range, groupBy: p.groupBy, files: true });
			const polished = await polishRecap(db, recap, cfg);
			return c.json({
				polished,
				text: formatText(polished),
				markdown: formatMarkdown(polished),
			} satisfies RecapPolishResponse);
		} catch (e) {
			if (e instanceof PolishError)
				return c.json({ error: { code: "polish_failed", message: e.message, reason: e.reason } }, 502);
			throw e;
		} finally {
			polishing = false;
		}
	});
}

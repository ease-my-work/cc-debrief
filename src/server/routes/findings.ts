// GET /api/findings, POST /api/findings/:id/feedback, POST /api/findings/:id/dismiss,
// POST /api/findings/rules/:rule/enable (features 07, 09; Phase 4 spec decisions 3, 4, 9).
import type { Context, Hono } from "hono";
import { z } from "zod";
import {
	dismissFinding,
	dismissSessionFindings,
	enableRule,
	recordFeedback,
	UnknownFindingError,
} from "../../coach/feedback";
import { RULE_LABELS } from "../../coach/labels";
import type { Db } from "../../db/adapter";
import { listFindings } from "../../db/queries/findings";
import { HttpError } from "../errors";
import type { DismissResponse, FeedbackResponse, FindingsResponse } from "../types";
import { parseQuery, RangeParam, RepoParam } from "./params";

const ListParams = z.object({
	range: RangeParam.optional(),
	repo: RepoParam.optional(),
	session: z.string().min(1).max(200).optional(),
});
const FeedbackBody = z.object({ value: z.enum(["helpful", "not_helpful"]) });
const DismissBody = z.object({ scope: z.enum(["group", "session"]).optional() });

function findingId(c: Context): number {
	const raw = c.req.param("id") ?? "";
	const id = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
	if (!Number.isSafeInteger(id)) throw new HttpError(404, "not_found", "No such finding");
	return id;
}

async function body<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
	const raw = await c.req.json().catch(() => ({}));
	const r = schema.safeParse(raw ?? {});
	if (!r.success) {
		const issue = r.error.issues[0];
		throw new HttpError(
			400,
			"bad_request",
			`Invalid ${issue?.path.join(".") || "body"}: ${issue?.message ?? "bad value"}`,
		);
	}
	return r.data;
}

/** Runs fn, turning UnknownFindingError into a 404. */
function withFinding<T>(fn: () => T): T {
	try {
		return fn();
	} catch (e) {
		if (e instanceof UnknownFindingError) throw new HttpError(404, "not_found", "No such finding");
		throw e;
	}
}

export function registerFindingRoutes(app: Hono, db: Db): void {
	// A session's findings come back whatever their age; otherwise the range defaults to 7 days.
	app.get("/api/findings", (c) => {
		const p = parseQuery(c, ListParams);
		const range = p.range ?? (p.session ? undefined : "7d");
		return c.json({ findings: listFindings(db, { ...p, range, now: new Date() }) } satisfies FindingsResponse);
	});

	app.post("/api/findings/rules/:rule/enable", (c) => {
		const rule = c.req.param("rule");
		if (!(rule in RULE_LABELS)) throw new HttpError(404, "not_found", `No rule ${rule}`);
		enableRule(db, rule);
		return c.json({ ok: true });
	});

	app.post("/api/findings/:id/feedback", async (c) => {
		const id = findingId(c);
		const { value } = await body(c, FeedbackBody);
		const { demoted } = withFinding(() => recordFeedback(db, id, value));
		return c.json({ ok: true, demoted } satisfies FeedbackResponse);
	});

	app.post("/api/findings/:id/dismiss", async (c) => {
		const id = findingId(c);
		const { scope } = await body(c, DismissBody);
		const dismissedUntil = withFinding(() =>
			scope === "session" ? dismissSessionFindings(db, id) : dismissFinding(db, id),
		);
		return c.json({ ok: true, dismissedUntil } satisfies DismissResponse);
	});
}

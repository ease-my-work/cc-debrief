// GET /api/sessions, GET /api/sessions/:id (Phase 2); POST /api/sessions/:id/summarize, GET /api/summaries/estimate,
// POST /api/summaries/run (Phase 3 spec decision 1); POST /api/sessions/:id/review, POST /api/sessions/:id/review/feedback,
// POST /api/reviews/run (Phase 5a spec decisions 2, 3, 6).
import type { Hono } from "hono";
import { z } from "zod";
import { recordReviewFeedback, UnknownFindingError } from "../../coach/feedback";
import { eligibleReviewIds, estimateReviewAll, reviewSession } from "../../coach/review";
import { sessionReviewBand } from "../../coach/review-band";
import { estimateSummaryCost, pendingSummaryIds, summarizeSessionResult } from "../../collector/summarize";
import { loadConfig } from "../../config";
import type { Db } from "../../db/adapter";
import { getReplay } from "../../db/queries/replay";
import { aiCallsToday } from "../../db/queries/selfUsage";
import { DEFAULT_LIMIT, decodeCursor, getSessionDetail, listSessions, MAX_LIMIT } from "../../db/queries/sessions";
import { withSessionLock } from "../../locks";
import { HttpError } from "../errors";
import { startReviewJob, startSummaryJob } from "../jobs";
import type {
	ReplayResponse,
	ReviewFeedbackResponse,
	ReviewResponse,
	ReviewRunResponse,
	SessionDetail,
	SessionsResponse,
	SummarizeResponse,
	SummaryEstimate,
	SummaryRunResponse,
} from "../types";
import { parseQuery, RangeParam, RepoParam, SessionTypeParam } from "./params";

const ListParams = z.object({
	range: RangeParam.default("7d"),
	repo: RepoParam.optional(),
	type: SessionTypeParam.optional(),
	q: z.string().max(500).optional(),
	cursor: z
		.string()
		.refine((c) => decodeCursor(c) !== null, "not a cursor from this server")
		.optional(),
	limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
});

const SinceDate = z
	.string()
	.refine((v) => !Number.isNaN(Date.parse(v)), "not a date (YYYY-MM-DD)")
	.transform((v) => new Date(v));

export function registerSessionRoutes(app: Hono, db: Db): void {
	app.get("/api/sessions", (c) => {
		const p = parseQuery(c, ListParams);
		return c.json(listSessions(db, { ...p, now: new Date() }) satisfies SessionsResponse);
	});
	app.get("/api/sessions/:id", (c) => {
		const detail = getSessionDetail(db, c.req.param("id"));
		if (!detail) throw new HttpError(404, "not_found", "No such session");
		return c.json(detail satisfies SessionDetail);
	});

	app.get("/api/sessions/:id/replay", (c) => {
		const replay = getReplay(db, c.req.param("id"));
		if (!replay) throw new HttpError(404, "not_found", "No such session");
		return c.json(replay satisfies ReplayResponse);
	});

	// An explicit request: imported sessions are allowed, the daily cap still applies.
	app.post("/api/sessions/:id/summarize", async (c) => {
		const id = c.req.param("id");
		if (!db.prepare("SELECT 1 AS x FROM sessions WHERE session_id = ?").get(id)) {
			throw new HttpError(404, "not_found", "No such session");
		}
		const r = await withSessionLock(id, { waitMs: 0 }, () =>
			summarizeSessionResult(db, id, loadConfig(), { explicit: true }),
		);
		const body: SummarizeResponse =
			r === "busy" ? { status: "skipped", costUsd: null, reason: "session is busy, try again" } : r;
		return c.json(body);
	});

	// A click (spec decision 6): reviews on and the session ended; the cap and the in-flight guard apply.
	app.post("/api/sessions/:id/review", async (c) => {
		const id = c.req.param("id");
		if (!db.prepare("SELECT 1 AS x FROM sessions WHERE session_id = ?").get(id)) {
			throw new HttpError(404, "not_found", "No such session");
		}
		const cfg = loadConfig();
		const r = await reviewSession(db, id, cfg, { trigger: "click" });
		switch (r.status) {
			case "done":
				return c.json({
					reviewId: r.reviewId as number,
					costUsd: r.costUsd ?? null,
					band: sessionReviewBand(db, id, cfg),
				} satisfies ReviewResponse);
			case "disabled":
				throw new HttpError(409, "reviews_disabled", "Reviews are off: turn them on in Settings");
			case "busy":
				throw new HttpError(409, "review_in_flight", "This session is being reviewed");
			case "open":
				throw new HttpError(409, "session_open", "The session has not ended yet");
			case "capped":
				throw new HttpError(429, "review_cap_reached", "Daily review cap reached");
			default:
				throw new HttpError(502, "review_failed", r.reason ?? "review failed");
		}
	});

	app.post("/api/sessions/:id/review/feedback", async (c) => {
		const body = z
			.object({ value: z.enum(["helpful", "not_helpful"]) })
			.safeParse(await c.req.json().catch(() => null));
		if (!body.success) throw new HttpError(400, "bad_request", 'Send { value: "helpful" | "not_helpful" }');
		try {
			const demoted = recordReviewFeedback(db, c.req.param("id"), body.data.value);
			return c.json({ demoted } satisfies ReviewFeedbackResponse);
		} catch (e) {
			if (e instanceof UnknownFindingError) throw new HttpError(404, "not_found", "No review for this session");
			throw e;
		}
	});

	app.post("/api/reviews/run", async (c) => {
		const body = z.object({ scope: z.literal("eligible_7d") }).safeParse(await c.req.json().catch(() => null));
		if (!body.success) throw new HttpError(422, "invalid_body", 'Send { scope: "eligible_7d" }');
		const cfg = loadConfig();
		if (!cfg.ai.review.enabled)
			throw new HttpError(409, "reviews_disabled", "Reviews are off: turn them on in Settings");
		const ids = eligibleReviewIds(db, cfg);
		const estUsd = estimateReviewAll(db, ids, cfg);
		const queued = startReviewJob(db, ids, cfg);
		if (queued === "busy") throw new HttpError(409, "job_running", "A review run is already in progress");
		return c.json({ queued, estUsd } satisfies ReviewRunResponse);
	});

	app.get("/api/summaries/estimate", (c) => {
		const { since } = parseQuery(c, z.object({ since: SinceDate }));
		const cfg = loadConfig();
		const sessions = pendingSummaryIds(db, { since }).length;
		const each = estimateSummaryCost(db, cfg);
		return c.json({
			sessions,
			estUsd: each === null ? null : each * sessions,
			capRemainingToday: Math.max(0, cfg.ai.maxPerDay - aiCallsToday(db, "summary")),
		} satisfies SummaryEstimate);
	});

	app.post("/api/summaries/run", async (c) => {
		const body = z.object({ since: SinceDate }).safeParse(await c.req.json().catch(() => null));
		if (!body.success) throw new HttpError(422, "invalid_body", 'Send { since: "YYYY-MM-DD" }');
		const ids = pendingSummaryIds(db, { since: body.data.since });
		const queued = startSummaryJob(db, ids, loadConfig());
		if (queued === "busy") throw new HttpError(409, "job_running", "A summary run is already in progress");
		return c.json({ queued } satisfies SummaryRunResponse);
	});
}

// GET /api/patterns, POST /api/patterns/:id/dismiss (feature 10); POST /api/patterns/:id/draft, /draft-rule,
// GET / PUT /api/patterns/:id/draft, POST /api/patterns/:id/install (feature 11; Phase 5b plan Task 10).
import type { Context, Hono } from "hono";
import { z } from "zod";
import { ClaudeError } from "../../claude/headless";
import { loadConfig } from "../../config";
import type { Db } from "../../db/adapter";
import { getPattern, setPatternStatus } from "../../db/queries/patterns";
import { UnknownPatternError } from "../../patterns/context";
import {
	DraftsDisabledError,
	draftDeterministic,
	draftPattern,
	InvalidDraftError,
	readDraft,
	saveDraft,
} from "../../patterns/draft";
import { installDraft, resolveInstallTarget, UnsafeTargetError } from "../../patterns/install";
import { draftEstimate, patternRows } from "../../patterns/views";
import { HttpError } from "../errors";
import type { DraftFile, DraftResponse, DraftRuleResponse, InstallResponse, PatternsResponse } from "../types";
import { parseQuery } from "./params";

const ListParams = z.object({
	repo: z.string().min(1).max(500).optional(),
	status: z.enum(["candidate", "drafted", "installed", "dismissed"]).optional(),
});
const DraftBody = z.object({ mode: z.enum(["create", "widen", "rewrite_rule"]).optional() });
const SaveBody = z.object({ content: z.string().max(200_000) });

function patternId(c: Context): number {
	const raw = c.req.param("id") ?? "";
	const id = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
	if (!Number.isSafeInteger(id)) throw new HttpError(404, "not_found", "No such pattern");
	return id;
}

async function body<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
	const r = schema.safeParse((await c.req.json().catch(() => ({}))) ?? {});
	if (!r.success) throw new HttpError(400, "bad_request", `Invalid body: ${r.error.issues[0]?.message ?? "bad value"}`);
	return r.data;
}

/** Maps the pattern layer's errors to HTTP. */
function http(e: unknown): never {
	if (e instanceof UnknownPatternError) throw new HttpError(404, "not_found", "No such pattern");
	if (e instanceof DraftsDisabledError) throw new HttpError(409, "drafts_disabled", e.message);
	if (e instanceof UnsafeTargetError) throw new HttpError(409, e.code, e.message);
	if (e instanceof InvalidDraftError) throw new HttpError(409, "invalid_draft", e.message);
	if (e instanceof ClaudeError) throw new HttpError(502, "draft_failed", e.message);
	throw e;
}

export function registerPatternRoutes(app: Hono, db: Db): void {
	app.get("/api/patterns", (c) => {
		const p = parseQuery(c, ListParams);
		return c.json({ patterns: patternRows(db, loadConfig(), p) } satisfies PatternsResponse);
	});

	app.post("/api/patterns/:id/dismiss", (c) => {
		const id = patternId(c);
		if (!getPattern(db, id)) throw new HttpError(404, "not_found", "No such pattern");
		db.transaction(() => {
			setPatternStatus(db, id, "dismissed");
			// Its digest item goes now; detection leaves a dismissed row without a finding (feature 10 step 7).
			db.prepare("DELETE FROM findings WHERE session_id IS NULL AND subject_key = ? AND feedback IS NULL").run(
				`pattern:${id}`,
			);
		});
		return c.json({ ok: true as const });
	});

	// An AI draft by click: the estimate is computed first so the response carries both.
	app.post("/api/patterns/:id/draft", async (c) => {
		const id = patternId(c);
		const { mode = "create" } = await body(c, DraftBody);
		const cfg = loadConfig();
		const p = getPattern(db, id);
		if (!p) throw new HttpError(404, "not_found", "No such pattern");
		const estUsd = draftEstimate(db, p, cfg);
		try {
			const r = await draftPattern(db, id, cfg, { mode });
			return c.json({ draftPath: r.draftPath, costUsd: r.costUsd, estUsd } satisfies DraftResponse);
		} catch (e) {
			return http(e);
		}
	});

	app.post("/api/patterns/:id/draft-rule", (c) => {
		try {
			return c.json(draftDeterministic(db, patternId(c)) satisfies DraftRuleResponse);
		} catch (e) {
			return http(e);
		}
	});

	app.get("/api/patterns/:id/draft", (c) => {
		const id = patternId(c);
		try {
			const draft = readDraft(id, db);
			let target: string | null = null;
			try {
				target = resolveInstallTarget(db, id).file;
			} catch {
				target = null; // repo gone or invalid draft: Install will say why
			}
			return c.json({ ...draft, target } satisfies DraftFile);
		} catch (e) {
			if (e instanceof InvalidDraftError) throw new HttpError(404, "not_found", e.message);
			return http(e);
		}
	});

	app.put("/api/patterns/:id/draft", async (c) => {
		const id = patternId(c);
		const { content } = await body(c, SaveBody);
		try {
			saveDraft(db, id, content);
		} catch (e) {
			if (e instanceof InvalidDraftError) throw new HttpError(422, "invalid_draft", e.message);
			return http(e);
		}
		return c.json({ ok: true as const });
	});

	app.post("/api/patterns/:id/install", (c) => {
		try {
			return c.json(installDraft(db, patternId(c)) satisfies InstallResponse);
		} catch (e) {
			return http(e);
		}
	});
}

import { type Command, Option } from "commander";
import {
	estimateSummaryCost,
	pendingSummaryIds,
	type SummaryOutcome,
	summarizeSessionResult,
} from "../collector/summarize";
import { type Config, loadConfig } from "../config";
import type { Db } from "../db/adapter";
import { runRetention } from "../db/queries/retention";
import { aiCallsToday, cleanupInternalSessions } from "../db/queries/selfUsage";
import { enrichPending, enrichSession } from "../enrich";
import { ingestPendingLocked } from "../ingest/ingest";
import { withSessionLock } from "../locks";
import { checkSessionId, count, type Out, parseDate, parsePositiveInt, quietly, stdout, withDb } from "./common";

const DEFAULT_LIMIT = 100;

type EnrichCliOptions = { ai?: boolean; since?: Date; limit?: number; fromHook?: boolean };

const usd = (v: number | null) => (v === null ? "unknown" : `~$${v < 0.01 && v > 0 ? v.toFixed(3) : v.toFixed(2)}`);

function describeSummary(r: SummaryOutcome | null): string {
	if (r === null) return "(no AI)";
	return `· summary ${r.status}${r.reason ? ` (${r.reason})` : ""}`;
}

/**
 * Summaries for pending sessions, one at a time, stopping at the daily cap: hook-captured ones by default; with since,
 * every session started since then, imported ones included (an explicit request, with a cost estimate first).
 */
export async function summarizePending(
	db: Db,
	cfg: Config,
	opts: { since?: Date; limit: number; out: Out },
): Promise<{ done: number; skipped: number; capped: number; errors: number }> {
	const tally = { done: 0, skipped: 0, capped: 0, errors: 0 };
	if (!cfg.ai.summaries.enabled) return tally;
	const explicit = opts.since !== undefined;
	const ids = pendingSummaryIds(db, {
		capture: explicit ? undefined : "hooks",
		since: opts.since,
		limit: opts.limit,
	});
	if (explicit) {
		const each = estimateSummaryCost(db, cfg);
		const left = Math.max(0, cfg.ai.maxPerDay - aiCallsToday(db, "summary"));
		opts.out(
			`${count(ids.length, "session")} · est. ${usd(each === null ? null : each * ids.length)} · ${left} left in today's cap`,
		);
	}
	for (const id of ids) {
		const r = await withSessionLock(id, { waitMs: 0 }, () => summarizeSessionResult(db, id, cfg, { explicit }));
		if (r === "busy") continue;
		if (r.status === "capped") {
			tally.capped += 1;
			break;
		}
		if (r.status === "done") tally.done++;
		else if (r.status === "error") tally.errors++;
		else tally.skipped++;
	}
	return tally;
}

export function registerEnrichCommand(program: Command): void {
	program
		.command("enrich")
		.description("finish sessions: the rest of the transcript, git end state, line counts and the AI summary")
		.argument("[session_id]", "only this session (default: every session not enriched yet, and pending summaries)")
		.option("--ai", "summarize with claude -p (the default; with --since, imported sessions too)")
		.option("--no-ai", "never call claude -p")
		.option("--since <date>", "with --ai: also summarize imported sessions started after this date", parseDate)
		.option("--limit <n>", `at most this many sessions (default ${DEFAULT_LIMIT})`, parsePositiveInt)
		.addOption(new Option("--from-hook", "run quietly as the SessionEnd hook's worker").hideHelp())
		.action(async (id: string | undefined, opts: EnrichCliOptions) => {
			const out = opts.fromHook ? () => {} : stdout;
			const ai = opts.ai !== false;
			await quietly("enrich", opts.fromHook, () =>
				withDb(async (db) => {
					const cfg = loadConfig();
					if (id) {
						const sessionId = checkSessionId(id);
						const r = await enrichSession(db, sessionId, {
							ai,
							explicit: !opts.fromHook,
							catchUp: opts.fromHook,
							config: cfg,
						});
						const known = db.prepare("SELECT 1 AS x FROM sessions WHERE session_id = ?").get(sessionId);
						if (!known) throw new Error(`unknown session ${sessionId}`);
						out(`enriched session ${sessionId} ${describeSummary(r)}`);
					} else {
						// Sessions whose transcripts were never read have no row yet; read them first.
						await ingestPendingLocked(db);
						const limit = opts.limit ?? DEFAULT_LIMIT;
						const n = await enrichPending(db, { ai: false, limit });
						if (!ai) {
							out(`enriched ${count(n, "session")} (no AI)`);
						} else {
							const t = await summarizePending(db, cfg, { since: opts.since, limit, out });
							const capped = t.capped ? `, daily cap reached` : "";
							out(
								`enriched ${count(n, "session")} (${count(t.done, "summary", "summaries")}, ${t.skipped} skipped${capped}) · ${count(t.errors, "error")}`,
							);
						}
					}
					// Leftovers of our own calls when environment inheritance failed (feature 15), then automatic retention.
					cleanupInternalSessions(db);
					runRetention(db, cfg);
				}),
			);
		});
}

// In-process jobs. Summary job for POST /api/summaries/run (Phase 3 spec decision 1): one call at a time in the dashboard
// process, stopping at the daily cap or after 3 failed sessions in a row; progress is read by GET /api/status.
import { reviewSession } from "../coach/review";
import { summarizeSessionResult } from "../collector/summarize";
import type { Config } from "../config";
import type { Db } from "../db/adapter";
import { repriceStale } from "../derive/reprice";
import { withSessionLock } from "../locks";
import type { JobProgress } from "./types";

const ERROR_STREAK = 3;

type Job = { done: number; total: number; promise: Promise<void> };
let job: Job | null = null;

export function getSummaryJob(): JobProgress | null {
	return job ? { done: job.done, total: job.total } : null;
}

/** Starts summarizing the sessions (explicit requests); "busy" when a job is already running. */
export function startSummaryJob(db: Db, ids: string[], cfg: Config): number | "busy" {
	if (job) return "busy";
	const current: Job = { done: 0, total: ids.length, promise: Promise.resolve() };
	job = current;
	current.promise = (async () => {
		let streak = 0;
		try {
			for (const id of ids) {
				const r = await withSessionLock(id, { waitMs: 0 }, () =>
					summarizeSessionResult(db, id, cfg, { explicit: true }),
				);
				current.done++;
				if (r === "busy") continue;
				if (r.status === "capped") break;
				streak = r.status === "error" ? streak + 1 : 0;
				if (streak >= ERROR_STREAK) break;
			}
		} catch {
			// a closed DB on shutdown ends the job; each session's own failure is already in summary_error
		} finally {
			job = null;
		}
	})();
	return ids.length;
}

/** Resolves when the running job (if any) has finished: for shutdown and tests. */
export async function waitForSummaryJob(): Promise<void> {
	await job?.promise;
}

// "Review all" (Phase 5a spec decision 2): the same shape, one review at a time, as clicks (the review-<id> lock is
// taken by reviewSession), stopping at the review cap or after 3 failed sessions in a row.
let reviewJob: Job | null = null;

export function getReviewJob(): JobProgress | null {
	return reviewJob ? { done: reviewJob.done, total: reviewJob.total } : null;
}

/** Starts reviewing the sessions; "busy" when a review job is already running. */
export function startReviewJob(db: Db, ids: string[], cfg: Config): number | "busy" {
	if (reviewJob) return "busy";
	const current: Job = { done: 0, total: ids.length, promise: Promise.resolve() };
	reviewJob = current;
	current.promise = (async () => {
		let streak = 0;
		try {
			for (const id of ids) {
				const r = await reviewSession(db, id, cfg, { trigger: "click" });
				current.done++;
				if (r.status === "capped" || r.status === "disabled") break;
				streak = r.status === "error" ? streak + 1 : 0;
				if (streak >= ERROR_STREAK) break;
			}
		} catch {
			// a closed DB on shutdown ends the job
		} finally {
			reviewJob = null;
		}
	})();
	return ids.length;
}

export async function waitForReviewJob(): Promise<void> {
	await reviewJob?.promise;
}

// Re-pricing (Phase 7 P7): started on dashboard start and by a pricing change in Settings. One run at a time; a
// change during a run asks for one more pass, which picks up whatever the change made stale.
let repriceJob: { progress: JobProgress; again: boolean; promise: Promise<void> } | null = null;

export function getRepriceJob(): JobProgress | null {
	return repriceJob ? { ...repriceJob.progress } : null;
}

export function startRepriceJob(db: Db, signal?: AbortSignal): void {
	if (repriceJob) {
		repriceJob.again = true;
		return;
	}
	const current = { progress: { done: 0, total: 0 }, again: false, promise: Promise.resolve() };
	repriceJob = current;
	current.promise = (async () => {
		try {
			do {
				current.again = false;
				current.progress = { done: 0, total: 0 };
				await repriceStale(db, {
					signal,
					onProgress: (done, total) => {
						current.progress = { done, total };
					},
				});
			} while (current.again && !signal?.aborted);
		} catch {
			// a closed DB on shutdown ends the job; a stale session is re-priced next time
		} finally {
			repriceJob = null;
		}
	})();
}

export async function waitForRepriceJob(): Promise<void> {
	await repriceJob?.promise;
}

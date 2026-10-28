// The Session review band with its Tier 2 part (features 08, 12; Phase 5a plan Task 6): the Phase 4 band (findings,
// dismissal, permission prompts, nudge) plus the review state, the click's estimate, the daily cap and the stored
// review's advice.
import type { Config } from "../config";
import type { Db } from "../db/adapter";
import { reviewBand } from "../db/queries/findings";
import { getReview } from "../db/queries/reviews";
import { aiCallsToday } from "../db/queries/selfUsage";
import { sessionLockHeld } from "../locks";
import type { ReviewBand } from "../server/types";
import { estimateReviewCost, type ReviewResult } from "./review";

/** state: disabled (reviews off), running (its review-<id> lock is held), reviewed, else not_reviewed. */
export function sessionReviewBand(db: Db, sessionId: string, cfg: Config, now: Date = new Date()): ReviewBand {
	const band = reviewBand(db, sessionId, cfg, now);
	if (!cfg.ai.review.enabled) return band;
	const review = getReview(db, sessionId);
	const result = review?.result as ReviewResult | undefined;
	return {
		...band,
		state: sessionLockHeld(`review-${sessionId}`) ? "running" : review ? "reviewed" : "not_reviewed",
		estUsd: estimateReviewCost(db, sessionId, cfg),
		capReached: aiCallsToday(db, "review", now) >= cfg.ai.review.maxPerDay,
		tier2:
			review && result
				? {
						betterApproach: result.better_approach,
						whatWentWell: result.what_went_well,
						suggestedFirstPrompt: result.suggested_first_prompt,
						confidence: result.confidence,
						costUsd: review.costUsd,
						model: review.model,
						feedback: review.feedback,
					}
				: null,
	};
}

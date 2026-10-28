// GET /api/improvements (feature 09) footer: reviews this week and their cost, dismissed findings, eligible
// unreviewed sessions with the "Review all" estimate, the self-usage line and the reviews nudge. The items come from
// buildDigest() (src/coach/digest.ts).
import { eligibleReviewIds, estimateReviewAll } from "../../coach/review";
import type { Config } from "../../config";
import type { DigestFooter } from "../../server/types";
import type { Db } from "../adapter";
import { getMeta } from "./meta";
import { reviewsThisWeek } from "./reviews";
import { selfUsageLine } from "./selfUsage";

export const NUDGES = ["overview", "session"] as const;
export type NudgeName = (typeof NUDGES)[number];
export const nudgeKey = (name: NudgeName) => `nudge.${name}.dismissed_at`;

export function nudgeDismissed(db: Db, name: NudgeName): boolean {
	return getMeta(db, nudgeKey(name)) !== null;
}

/** Footer for the rolling 7 days whatever the range (feature 09). */
export function digestFooter(db: Db, cfg: Config, now: Date = new Date()): DigestFooter {
	const dismissed =
		db
			.prepare("SELECT count(*) AS n FROM findings WHERE created_at >= ? AND dismissed_until > ?")
			.get<{ n: number }>(new Date(now.getTime() - 7 * 86_400_000).toISOString(), now.toISOString())?.n ?? 0;
	const week = reviewsThisWeek(db, now);
	const eligible = eligibleReviewIds(db, cfg, now);
	return {
		reviewsThisWeek: week.count,
		reviewCostUsd: week.costUsd,
		dismissed,
		eligibleUnreviewed: eligible.length,
		estReviewAllUsd: estimateReviewAll(db, eligible, cfg),
		reviewsEnabled: cfg.ai.review.enabled,
		nudgeDismissed: nudgeDismissed(db, "overview"),
		selfUsage: selfUsageLine(db, now),
	};
}

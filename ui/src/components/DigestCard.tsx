// The coaching digest card (feature 09): up to three items ranked by cost for the overview's range and repo, then
// the footer: the reviews lines with "Review all" (Phase 5a) or the dismissable reviews nudge (feature 16), and the
// tracker's own usage (feature 15).
import type { ImprovementsResponse, SelfUsageLine } from "@api-types";
import { Link } from "wouter";
import { sendJson } from "../api";
import { compactTokens, num, usd } from "../lib/format";
import { useApi } from "../lib/useApi";
import { DigestItem } from "./DigestItem";
import { ReviewAllButton } from "./ReviewAllButton";

/** Feature 15: nearest integer; "<1%" above 0 and below 0.5; "—" without a denominator. */
export function sharePctText(pct: number | null): string {
	if (pct === null) return "—";
	if (pct > 0 && pct < 0.5) return "<1%";
	return `${Math.round(pct)}%`;
}

const calls = (n: number, one: string, many: string) => `${num(n)} ${n === 1 ? one : many}`;

/** "This package used: 42 summaries + 6 reviews · 310k tokens · $1.40 · 7% of your week" (feature 15). */
export function selfUsageText(l: SelfUsageLine): string {
	if (l.summaries + l.reviews + l.drafts + l.recaps === 0 && l.tokens === 0)
		return "This package used nothing this week";
	const parts = [calls(l.summaries, "summary", "summaries"), calls(l.reviews, "review", "reviews")];
	if (l.drafts > 0) parts.push(calls(l.drafts, "draft", "drafts"));
	if (l.recaps > 0) parts.push(calls(l.recaps, "recap", "recaps"));
	return `This package used: ${parts.join(" + ")} · ${compactTokens(l.tokens)} tokens · ${usd(l.usd)} · ${sharePctText(l.sharePct)} of your week`;
}

export function DigestCard({ range, repo }: { range?: string; repo?: string | null } = {}) {
	const { data, reload } = useApi<ImprovementsResponse>("/api/improvements", { range, repo });
	const f = data?.footer;
	const dismiss = async () => {
		try {
			await sendJson("POST", "/api/nudges/overview/dismiss");
		} finally {
			reload();
		}
	};
	return (
		<section className="card flex flex-col" aria-label="This week's coaching digest">
			<div className="flex items-center gap-2 px-4 pt-3.5 pb-2.5">
				<div className="section-h flex-grow">This week's coaching digest</div>
				<span className="text-[12px] text-muted">ranked by cost</span>
			</div>
			{data && data.items.length > 0 ? (
				<ul className="m-0 list-none p-0">
					{data.items.map((item) => (
						<DigestItem key={item.id} item={item} onDismissed={reload} />
					))}
				</ul>
			) : data ? (
				<p className="m-0 px-4 pb-6 text-[13.5px] text-muted">No costly patterns this week</p>
			) : null}
			{f ? (
				<div className="mt-auto flex flex-col gap-1.5 rounded-b-xl border-t border-row bg-band px-4 py-2.5 text-[12px] text-muted">
					{f.reviewsEnabled ? (
						<>
							<div>
								Reviews this week: {num(f.reviewsThisWeek)}
								{f.reviewsThisWeek > 0 ? ` · ${usd(f.reviewCostUsd)}` : ""} · {num(f.dismissed)} dismissed
							</div>
							{f.eligibleUnreviewed > 0 ? (
								<div className="flex flex-wrap items-center gap-2.5">
									<span>
										{num(f.eligibleUnreviewed)} eligible {f.eligibleUnreviewed === 1 ? "session" : "sessions"} not
										reviewed
									</span>
									<span className="flex-grow" />
									<ReviewAllButton count={f.eligibleUnreviewed} estUsd={f.estReviewAllUsd} onFinished={reload} />
								</div>
							) : null}
						</>
					) : f.nudgeDismissed ? null : (
						<div className="flex items-center gap-2.5">
							<span>Enable reviews for better insights</span>
							<Link href="/settings#reviews" className="text-[12.5px] font-medium no-underline">
								Enable reviews
							</Link>
							<span className="flex-grow" />
							<button
								type="button"
								aria-label="Dismiss tip"
								onClick={dismiss}
								className="flex h-5 w-5 items-center justify-center rounded border-0 bg-transparent p-0 text-muted"
							>
								<svg
									width="12"
									height="12"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									strokeWidth="2.5"
									aria-hidden="true"
								>
									<path d="M6 6l12 12M18 6 6 18" />
								</svg>
							</button>
						</div>
					)}
					<div className="flex items-center gap-2.5">
						<span>{selfUsageText(f.selfUsage)}</span>
						<span className="flex-grow" />
						<Link href="/settings" className="text-[12.5px] font-medium no-underline">
							Settings
						</Link>
					</div>
				</div>
			) : null}
		</section>
	);
}

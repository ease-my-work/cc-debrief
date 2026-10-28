// The summary area of the session detail header (feature 06 UI): the summary with its outcome, or why there is none
// and, for a pending or failed session, the Summarize button.
import type { SessionDetail } from "@api-types";
import { SummarizeButton } from "./SummarizeButton";

function stateLine(d: SessionDetail): string {
	if (d.inProgress) return "Summarized after the session ends";
	switch (d.summaryState) {
		case "disabled":
			return "Summaries are off";
		case "error":
			return d.summaryError ? `Summary failed: ${d.summaryError}` : "Summary failed";
		case "skipped":
			return "No summary: fewer than 2 turns";
		default:
			return "Summary pending";
	}
}

export function SummaryBlock({ d, onChanged }: { d: SessionDetail; onChanged: () => void }) {
	if (d.summary) {
		return (
			<p className="m-0 text-[14px] leading-normal">
				{d.summary}
				{d.outcome ? ` Outcome: ${d.outcome}.` : ""}
			</p>
		);
	}
	const actionable = !d.inProgress && (d.summaryState === "pending" || d.summaryState === "error");
	return (
		<div className="flex flex-wrap items-center gap-3">
			<p className="m-0 text-[13px] text-muted">{stateLine(d)}</p>
			{actionable ? (
				<SummarizeButton
					sessionId={d.id}
					estUsd={d.summaryEstUsd}
					capReached={d.summaryCapReached}
					onDone={onChanged}
				/>
			) : null}
		</div>
	);
}

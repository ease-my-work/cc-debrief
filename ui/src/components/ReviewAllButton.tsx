// "Review all (~$0.50)" in the digest footer (feature 09; Phase 5a spec decision 2): asks first with the count and the
// estimate, then starts POST /api/reviews/run and shows the job's progress from GET /api/status until it ends.
import type { ReviewRunResponse, StatusResponse } from "@api-types";
import { useEffect, useState } from "react";
import { ApiErrorClass, getJson, sendJson } from "../api";
import { num, usd } from "../lib/format";

const POLL_MS = 2000;

export function ReviewAllButton({
	count,
	estUsd,
	onFinished,
}: {
	count: number;
	estUsd: number | null;
	onFinished: () => void;
}) {
	const [confirming, setConfirming] = useState(false);
	const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
	const [note, setNote] = useState<string | null>(null);
	const cost = estUsd === null ? "cost unknown" : `~${usd(estUsd)}`;

	useEffect(() => {
		if (!progress) return;
		const t = setInterval(async () => {
			try {
				const s = await getJson<StatusResponse>("/api/status");
				if (s.reviewJob) setProgress(s.reviewJob);
				else {
					setProgress(null);
					onFinished();
				}
			} catch {
				// keep polling
			}
		}, POLL_MS);
		return () => clearInterval(t);
	}, [progress, onFinished]);

	const start = async () => {
		setConfirming(false);
		setNote(null);
		try {
			const r = await sendJson<ReviewRunResponse>("POST", "/api/reviews/run", { scope: "eligible_7d" });
			setProgress({ done: 0, total: r.queued });
		} catch (e) {
			setNote(e instanceof ApiErrorClass ? e.message : String(e));
		}
	};

	if (progress) {
		return (
			<span role="status" className="text-[12px] text-muted">
				Reviewing {num(Math.min(progress.done + 1, progress.total))} of {num(progress.total)}…
			</span>
		);
	}
	if (confirming) {
		return (
			<span className="inline-flex items-center gap-2 text-[12px]">
				<span>
					Review {num(count)} {count === 1 ? "session" : "sessions"} ({cost})?
				</span>
				<button
					type="button"
					onClick={start}
					className="rounded-md border border-border bg-panel px-2 py-0.5 text-[12px] font-medium text-ink"
				>
					Review
				</button>
				<button
					type="button"
					onClick={() => setConfirming(false)}
					className="rounded-md border border-border bg-panel px-2 py-0.5 text-[12px] text-neutral-text"
				>
					Cancel
				</button>
			</span>
		);
	}
	return (
		<span className="inline-flex items-center gap-2">
			<button
				type="button"
				onClick={() => setConfirming(true)}
				className="rounded-md border border-border bg-panel px-2 py-0.5 text-[12px] font-medium text-ink"
			>
				Review all ({cost})
			</button>
			{note ? <span className="text-[12px] text-muted">{note}</span> : null}
		</span>
	);
}

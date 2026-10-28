// "Review this session (~$0.18)" / "Review again (~$0.18)" (feature 08 UI): a click review through
// POST /api/sessions/:id/review. Shows the estimate before (or "cost unknown"), "Reviewing… up to 3 min" while it runs,
// the actual cost after, and the reason inline when it fails. Disabled with "daily cap reached" once the cap is used.
import type { ReviewResponse } from "@api-types";
import { useState } from "react";
import { ApiErrorClass, sendJson } from "../api";
import { usd } from "../lib/format";

export function ReviewButton({
	sessionId,
	estUsd,
	capReached,
	again = false,
	onDone,
}: {
	sessionId: string;
	estUsd: number | null;
	capReached: boolean;
	again?: boolean;
	onDone: () => void;
}) {
	const [busy, setBusy] = useState(false);
	const [note, setNote] = useState<string | null>(null);
	const [cost, setCost] = useState<number | null | undefined>(undefined);
	const run = async () => {
		setBusy(true);
		setNote(null);
		try {
			const r = await sendJson<ReviewResponse>("POST", `/api/sessions/${encodeURIComponent(sessionId)}/review`);
			setCost(r.costUsd);
			onDone();
		} catch (e) {
			setNote(
				e instanceof ApiErrorClass
					? e.status === 429
						? "daily cap reached"
						: `Review failed: ${e.message}`
					: String(e),
			);
		} finally {
			setBusy(false);
		}
	};
	const label = `${again ? "Review again" : "Review this session"} (${estUsd === null ? "cost unknown" : `~${usd(estUsd)}`})`;
	return (
		<span className="inline-flex items-center gap-2">
			{cost !== undefined ? (
				<span className="text-[12px] text-muted">cost {usd(cost)}</span>
			) : (
				<button
					type="button"
					onClick={run}
					disabled={busy || capReached}
					className="rounded-md border border-border bg-panel px-2.5 py-1 text-[12px] font-medium text-ink disabled:opacity-60"
				>
					{busy ? "Reviewing… up to 3 min" : label}
				</button>
			)}
			{capReached && cost === undefined ? <span className="text-[12px] text-muted">daily cap reached</span> : null}
			{note ? (
				<span role="status" className="text-[12px] text-muted">
					{note}
				</span>
			) : null}
		</span>
	);
}

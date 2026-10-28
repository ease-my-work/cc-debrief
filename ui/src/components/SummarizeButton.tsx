// "Summarize (~$0.02)" on a pending or failed session, imported ones included (feature 06 UI): an explicit request
// through POST /api/sessions/:id/summarize. Disabled once today's summary cap is used up.
import type { SummarizeResponse } from "@api-types";
import { useState } from "react";
import { ApiErrorClass, sendJson } from "../api";
import { usd } from "../lib/format";

export function SummarizeButton({
	sessionId,
	estUsd,
	capReached,
	onDone,
}: {
	sessionId: string;
	estUsd: number | null;
	capReached: boolean;
	onDone: () => void;
}) {
	const [busy, setBusy] = useState(false);
	const [note, setNote] = useState<string | null>(null);
	const run = async () => {
		setBusy(true);
		setNote(null);
		try {
			const r = await sendJson<SummarizeResponse>("POST", `/api/sessions/${encodeURIComponent(sessionId)}/summarize`);
			if (r.status === "done") onDone();
			else if (r.status === "error") {
				setNote(`Summary failed: ${r.reason ?? "unknown error"}`);
				onDone();
			} else setNote(`Not summarized: ${r.reason ?? r.status}`);
		} catch (e) {
			setNote(e instanceof ApiErrorClass ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};
	const label = `Summarize${estUsd !== null ? ` (~${usd(estUsd)})` : ""}`;
	return (
		<span className="inline-flex items-center gap-2">
			<button
				type="button"
				onClick={run}
				disabled={busy || capReached}
				className="rounded-md border border-border bg-panel px-2.5 py-1 text-[12.5px] font-medium text-ink disabled:opacity-60"
			>
				{busy ? "Summarizing…" : label}
			</button>
			{capReached ? <span className="text-[12px] text-muted">daily cap reached</span> : null}
			{note ? <span className="text-[12px] text-muted">{note}</span> : null}
		</span>
	);
}

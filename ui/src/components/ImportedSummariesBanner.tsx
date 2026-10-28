// "412 imported sessions without summary · Summarize last 30 days (~$8.20)" on the Sessions list (feature 06): an
// estimate, a confirm step, then POST /api/summaries/run with progress from GET /api/status (summaryJob).
import type { StatusResponse, SummaryEstimate, SummaryRunResponse } from "@api-types";
import { useEffect, useRef, useState } from "react";
import { ApiErrorClass, getJson, sendJson } from "../api";
import { num, usd } from "../lib/format";
import { useApi } from "../lib/useApi";
import { useStatus } from "../lib/useLiveRefresh";

const DAYS = 30;
const POLL_MS = 2000;

function sinceDate(now = new Date()): string {
	const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - DAYS);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

type Step = "idle" | "confirm" | "running" | "done";

export function ImportedSummariesBanner({ onFinished }: { onFinished?: () => void }) {
	const status = useStatus();
	const [step, setStep] = useState<Step>("idle");
	const [job, setJob] = useState<StatusResponse["summaryJob"]>(null);
	const [error, setError] = useState<string | null>(null);
	const finished = useRef(onFinished);
	finished.current = onFinished;
	const pending = status?.pendingImportedSummaries ?? 0;
	const visible = status?.ai.summaries === true && (pending > 0 || step !== "idle");
	const since = sinceDate();
	const { data: est } = useApi<SummaryEstimate>(visible ? "/api/summaries/estimate" : null, { since });

	useEffect(() => {
		if (step !== "running") return;
		let stopped = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const tick = async () => {
			try {
				const s = await getJson<StatusResponse>("/api/status");
				if (stopped) return;
				setJob(s.summaryJob);
				if (s.summaryJob === null) {
					setStep("done");
					finished.current?.();
					return;
				}
			} catch {
				// keep polling
			}
			if (!stopped) timer = setTimeout(tick, POLL_MS);
		};
		void tick();
		return () => {
			stopped = true;
			if (timer) clearTimeout(timer);
		};
	}, [step]);

	if (!visible) return null;
	const cost = est?.estUsd != null ? ` (~${usd(est.estUsd)})` : "";
	const start = async () => {
		setError(null);
		try {
			const r = await sendJson<SummaryRunResponse>("POST", "/api/summaries/run", { since });
			setJob({ done: 0, total: r.queued });
			setStep("running");
		} catch (e) {
			setError(e instanceof ApiErrorClass ? e.message : String(e));
			setStep("idle");
		}
	};

	return (
		<div className="card flex flex-wrap items-center gap-3 px-4 py-2.5 text-[13px]" role="status">
			{step === "idle" ? (
				<>
					<span className="text-muted">{num(pending)} imported sessions without summary ·</span>
					<button
						type="button"
						onClick={() => setStep("confirm")}
						className="border-0 bg-transparent p-0 text-[13px] font-medium text-accent"
					>
						Summarize last {DAYS} days{cost}
					</button>
				</>
			) : step === "confirm" ? (
				<>
					<span>
						Summarize {num(est?.sessions ?? 0)} sessions for about {usd(est?.estUsd ?? null)}? At most{" "}
						{num(est?.capRemainingToday ?? 0)} run today (daily cap); the rest stay pending.
					</span>
					<span className="flex-grow" />
					<button
						type="button"
						onClick={start}
						className="rounded-md border border-ink bg-ink px-2.5 py-1 text-[12.5px] font-medium text-background"
					>
						Start
					</button>
					<button
						type="button"
						onClick={() => setStep("idle")}
						className="rounded-md border border-border bg-panel px-2.5 py-1 text-[12.5px] font-medium text-ink"
					>
						Cancel
					</button>
				</>
			) : step === "running" ? (
				<span>
					Summarizing {num(job?.done ?? 0)} of {num(job?.total ?? 0)}…
				</span>
			) : (
				<span className="text-muted">Summary run finished.</span>
			)}
			{error ? <span className="text-bad">{error}</span> : null}
		</div>
	);
}

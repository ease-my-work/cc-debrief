// The Session review band (features 07, 08, 12; mockup Sessions.html): Tier 1 and Tier 2 findings as severity badges
// with their messages and turn numbers, per-finding thumbs, low-confidence findings collapsed, "Dismiss 30d" for the
// session's findings, the review header (estimate before, cost and confidence after), the review's advice with a
// copyable first prompt and "Was this useful?", the permission-prompt state, and the reviews nudge while reviews are off.
import type { ReviewBand as Band } from "@api-types";
import { useState } from "react";
import { Link } from "wouter";
import { sendJson } from "../api";
import { usd } from "../lib/format";
import { richText } from "../lib/richText";
import { FeedbackButtons } from "./FeedbackButtons";
import { FindingBadge } from "./FindingBadge";
import { ReviewButton } from "./ReviewButton";

type Finding = Band["findings"][number];
type Vote = "helpful" | "not_helpful";

/** "turn 3" / "turns 2, 4", unless the message already names its turns. */
function turnsText(message: string, turns: number[]): string | null {
	if (turns.length === 0 || /\bturns? \d/.test(message)) return null;
	return `${turns.length === 1 ? "turn" : "turns"} ${turns.join(", ")}`;
}

function FindingList({ findings }: { findings: Finding[] }) {
	return (
		<ul className="m-0 flex list-none flex-col gap-2 p-0">
			{findings.map((f) => {
				const turns = turnsText(f.message, f.turns);
				return (
					<li key={f.id} className="flex items-start gap-2 text-[13px] leading-[1.45]">
						<FindingBadge label={f.label} severity={f.severity} />
						<span className="min-w-0 flex-grow">
							{richText(f.message)}
							{turns ? <span className="text-muted"> · {turns}</span> : null}
						</span>
						<FeedbackButtons findingId={f.id} initial={f.feedback} />
					</li>
				);
			})}
		</ul>
	);
}

function Useful({ sessionId, initial }: { sessionId: string; initial: Vote | null }) {
	const [vote, setVote] = useState<Vote | null>(initial);
	const send = async (value: Vote) => {
		const before = vote;
		setVote(value);
		try {
			await sendJson("POST", `/api/sessions/${encodeURIComponent(sessionId)}/review/feedback`, { value });
		} catch {
			setVote(before);
		}
	};
	const button = (value: Vote, label: string) => (
		<button
			type="button"
			aria-pressed={vote === value}
			onClick={() => send(value)}
			className={`rounded-md border px-2.5 py-0.5 text-[12px] ${
				vote === value ? "border-accent bg-accent-fill text-accent" : "border-border bg-panel text-neutral-text"
			}`}
		>
			{label}
		</button>
	);
	return (
		<div className="flex items-center gap-2 pt-0.5">
			<span className="text-[12px] text-muted">Was this useful?</span>
			{button("helpful", "Yes")}
			{button("not_helpful", "No")}
		</div>
	);
}

function CopyPrompt({ text }: { text: string }) {
	const [copied, setCopied] = useState(false);
	const copy = async () => {
		try {
			await navigator.clipboard.writeText(text);
			setCopied(true);
		} catch {
			setCopied(false);
		}
	};
	return (
		<div className="flex flex-col gap-1">
			<div className="flex items-center gap-2">
				<span className="font-semibold">Suggested first prompt</span>
				<button
					type="button"
					onClick={copy}
					className="rounded-md border border-border bg-panel px-2 py-0.5 text-[12px] text-neutral-text"
				>
					{copied ? "Copied" : "Copy"}
				</button>
			</div>
			<div className="mono rounded-md border border-row bg-panel px-2.5 py-1.5 text-[12.5px] whitespace-pre-wrap">
				{text}
			</div>
		</div>
	);
}

export function ReviewBand({
	band,
	sessionId,
	imported,
	onChanged,
}: {
	band: Band;
	sessionId: string;
	imported: boolean;
	onChanged: () => void;
}) {
	const post = async (path: string, body: unknown = {}) => {
		try {
			await sendJson("POST", path, body);
		} finally {
			onChanged();
		}
	};
	const first = band.findings[0];
	const shown = band.findings.filter((f) => !f.collapsed);
	const collapsed = band.findings.filter((f) => f.collapsed);
	const t2 = band.tier2;
	const findings =
		band.findings.length === 0 ? (
			<p className="m-0 text-[13px] text-muted">No findings for this session</p>
		) : (
			<div className="flex flex-col gap-2">
				<FindingList findings={shown} />
				{collapsed.length > 0 ? (
					<details className="text-[13px]">
						<summary className="cursor-pointer text-[12px] text-muted">
							Low-confidence findings ({collapsed.length})
						</summary>
						<div className="pt-2">
							<FindingList findings={collapsed} />
						</div>
					</details>
				) : null}
			</div>
		);
	return (
		<section
			id="review"
			aria-label="Session review"
			className="flex flex-col gap-2.5 border-b border-row bg-band px-5 py-3"
		>
			<div className="flex flex-wrap items-center gap-2.5">
				<div className="section-h flex-grow">Session review</div>
				{band.state === "running" ? (
					<span role="status" className="text-[12px] text-muted">
						Reviewing… up to 3 min
					</span>
				) : null}
				{band.state === "reviewed" && t2 ? (
					<span className="text-[12px] text-muted">
						reviewed · cost <span className="mono">{usd(t2.costUsd)}</span> · confidence {t2.confidence}
					</span>
				) : null}
				{band.state === "not_reviewed" || band.state === "reviewed" ? (
					<ReviewButton
						key={band.state}
						sessionId={sessionId}
						estUsd={band.estUsd}
						capReached={band.capReached}
						again={band.state === "reviewed"}
						onDone={onChanged}
					/>
				) : null}
				{first ? (
					<button
						type="button"
						onClick={() => post(`/api/findings/${first.id}/dismiss`, { scope: "session" })}
						className="rounded-md border border-border bg-panel px-2.5 py-1 text-[12px] text-neutral-text"
					>
						Dismiss 30d
					</button>
				) : null}
			</div>
			{t2 ? (
				<div className="grid grid-cols-1 gap-4 md:grid-cols-2">
					{findings}
					<div className="flex flex-col gap-1.5 text-[13px] leading-[1.45]">
						<div>
							<span className="font-semibold">Better approach:</span> {t2.betterApproach}
						</div>
						<div>
							<span className="font-semibold">Went well:</span> {t2.whatWentWell}
						</div>
						{t2.suggestedFirstPrompt ? <CopyPrompt text={t2.suggestedFirstPrompt} /> : null}
						<Useful key={sessionId} sessionId={sessionId} initial={t2.feedback} />
					</div>
				</div>
			) : (
				findings
			)}
			{band.permissionPrompts === "not_recorded" ? (
				<div className="flex flex-wrap gap-x-4 text-[12px] text-muted">
					<span>Permission prompts: not recorded ({imported ? "imported session" : "hook off"})</span>
				</div>
			) : null}
			{band.state === "disabled" && !band.nudgeDismissed ? (
				<div className="flex items-center gap-2.5 text-[12px] text-muted">
					<span>Enable reviews for better insights</span>
					<Link href="/settings#reviews" className="text-[12.5px] font-medium no-underline">
						Enable reviews
					</Link>
					<span className="flex-grow" />
					<button
						type="button"
						aria-label="Dismiss tip"
						onClick={() => post("/api/nudges/session/dismiss")}
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
			) : null}
		</section>
	);
}

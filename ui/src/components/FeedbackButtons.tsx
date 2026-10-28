// Helpful / not-helpful thumbs for a finding or digest item (features 07, 09): 28 px, aria-pressed shows the vote.
import { useState } from "react";
import { sendJson } from "../api";

type Vote = "helpful" | "not_helpful";

const UP = "M7 10v11H3V10zM7 10l4-8a3 3 0 0 1 3 3v5h6a2 2 0 0 1 2 2l-1.5 8a2 2 0 0 1-2 1.5H7";
const DOWN = "M17 14V3h4v11zM17 14l-4 8a3 3 0 0 1-3-3v-5H4a2 2 0 0 1-2-2l1.5-8A2 2 0 0 1 5.5 3H17";

export function FeedbackButtons({ findingId, initial }: { findingId: number; initial: Vote | null }) {
	const [vote, setVote] = useState<Vote | null>(initial);
	const send = async (value: Vote) => {
		const before = vote;
		setVote(value);
		try {
			await sendJson("POST", `/api/findings/${findingId}/feedback`, { value });
		} catch {
			setVote(before);
		}
	};
	const button = (value: Vote, label: string, path: string) => (
		<button
			type="button"
			aria-label={label}
			aria-pressed={vote === value}
			onClick={() => send(value)}
			className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md border p-0 ${
				vote === value ? "border-accent bg-accent-fill text-accent" : "border-border bg-panel text-neutral-text"
			}`}
		>
			<svg
				width="14"
				height="14"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="round"
				strokeLinejoin="round"
				aria-hidden="true"
			>
				<path d={path} />
			</svg>
		</button>
	);
	return (
		<div className="flex items-start gap-1">
			{button("helpful", "Helpful", UP)}
			{button("not_helpful", "Not helpful", DOWN)}
		</div>
	);
}

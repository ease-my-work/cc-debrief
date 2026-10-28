// One digest row (feature 09 UI): colour dot, message linking to the view that resolves it, "≈ N tokens", thumbs,
// and a dismiss button shown on hover or keyboard focus.
import type { DraftResponse, DigestItem as Item } from "@api-types";
import { type FocusEvent, useState } from "react";
import { Link } from "wouter";
import { ApiErrorClass, sendJson } from "../api";
import { compactTokens, usd } from "../lib/format";
import { richText } from "../lib/richText";
import { FeedbackButtons } from "./FeedbackButtons";

const PATTERN_RULES = new Set(["repeat_pattern", "test_gap", "skill_not_triggering"]);
/** Warm for Tier 1 / Tier 2 findings, accent for pattern suggestions (Phase 5b). */
const dotColour = (item: Item) => (PATTERN_RULES.has(item.rule) ? "#3453C4" : "#C9772E");

/** The inline "Draft skill (~$0.20)" of a pattern item: estimate before, actual cost (or the reason) after. */
function DraftAction({ action, onDone }: { action: NonNullable<Item["action"]>; onDone: () => void }) {
	const [state, setState] = useState<{ busy: boolean; note: string | null }>({ busy: false, note: null });
	const run = async () => {
		setState({ busy: true, note: null });
		try {
			const r = await sendJson<DraftResponse>("POST", `/api/patterns/${action.patternId}/draft`, { mode: "create" });
			setState({ busy: false, note: `drafted · cost ${usd(r.costUsd)}` });
			onDone();
		} catch (e) {
			setState({ busy: false, note: e instanceof ApiErrorClass ? e.message : String(e) });
		}
	};
	if (state.note) return <span role="status">{state.note}</span>;
	return (
		<button
			type="button"
			onClick={run}
			disabled={state.busy}
			className="border-0 bg-transparent p-0 text-[12px] font-medium text-accent disabled:opacity-60"
		>
			{state.busy ? "Drafting…" : `Draft skill (${action.estUsd === null ? "cost unknown" : `~${usd(action.estUsd)}`})`}
		</button>
	);
}

export function DigestItem({ item, onDismissed }: { item: Item; onDismissed: () => void }) {
	const [show, setShow] = useState(false);
	const dismiss = async () => {
		try {
			await sendJson("POST", `/api/findings/${item.id}/dismiss`, {});
		} finally {
			onDismissed();
		}
	};
	const leave = (e: FocusEvent<HTMLLIElement>) => {
		if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setShow(false);
	};
	return (
		<li
			className="flex items-start gap-2.5 border-t border-row px-4 py-2.5"
			onMouseEnter={() => setShow(true)}
			onMouseLeave={() => setShow(false)}
			onFocus={() => setShow(true)}
			onBlur={leave}
		>
			<span data-dot className="mt-1.5 h-2 w-2 shrink-0 rounded-full" style={{ background: dotColour(item) }} />
			<div className="min-w-0 flex-grow text-[13.5px] leading-[1.45]">
				<Link href={item.href} className="text-ink no-underline hover:underline">
					{richText(item.message)}
				</Link>
				<div className="text-[12px] text-muted">
					≈ {compactTokens(item.costTokens)} tokens
					{item.action ? (
						<>
							{" · "}
							<DraftAction action={item.action} onDone={onDismissed} />
						</>
					) : null}
				</div>
			</div>
			{show ? (
				<button
					type="button"
					aria-label="Dismiss"
					title="Dismiss for 30 days"
					onClick={dismiss}
					className="flex h-7 shrink-0 items-center rounded-md border border-border bg-panel px-2 text-[12px] text-muted"
				>
					Dismiss
				</button>
			) : null}
			<FeedbackButtons findingId={item.id} initial={item.feedback} />
		</li>
	);
}

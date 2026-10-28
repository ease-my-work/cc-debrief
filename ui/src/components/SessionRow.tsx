import type { SessionListItem } from "@api-types";
import { Link, useSearch } from "wouter";
import { duration, modelFamily, tokenText, usd, when } from "../lib/format";
import { TypeBadge } from "./TypeBadge";

/**
 * One row of the master list: repo, badges, time; summary line; tokens · cost · duration · models, and "Review (~$)"
 * on an eligible row (feature 08: the row opens the session, whose band has the review button).
 */
export function SessionRow({ s, selected }: { s: SessionListItem; selected: boolean }) {
	const search = useSearch();
	return (
		<Link
			href={`/sessions/${s.id}${search ? `?${search}` : ""}`}
			role="option"
			aria-selected={selected}
			id={`session-${s.id}`}
			tabIndex={-1}
			data-nav-item=""
			className={`relative flex flex-col gap-1 border-b border-row px-3.5 py-2.5 text-ink no-underline ${
				selected ? "bg-accent-fill" : "hover:bg-background"
			}`}
		>
			{selected ? <span className="absolute top-0 bottom-0 left-0 w-[3px] bg-accent" aria-hidden="true" /> : null}
			<span className="flex items-center gap-2">
				<span className="mono text-[13px] font-medium">{s.repo?.name ?? "—"}</span>
				<TypeBadge type={s.type} source={s.typeSource} />
				{s.inProgress ? <span className="badge bg-panel text-accent">In progress</span> : null}
				{s.imported ? <span className="badge bg-neutral-fill text-neutral-text">imported</span> : null}
				<span className="flex-grow" />
				<span className="text-[12px] text-muted">{when(s.startedAt)}</span>
			</span>
			<span className="text-[13px] leading-snug">{s.summaryLine ?? "—"}</span>
			<span className="flex flex-wrap gap-1.5 text-[12px] text-muted">
				<span className="mono">{tokenText(s)}</span>
				<span>·</span>
				<span>{usd(s.costUsd)}</span>
				<span>·</span>
				<span>{duration(s.durationSec)}</span>
				<span>·</span>
				<span>{modelFamily(s.models)}</span>
				{s.review?.state === "eligible" ? (
					<>
						<span>·</span>
						<span className="font-medium text-accent">
							Review ({s.review.estUsd === null ? "cost unknown" : `~${usd(s.review.estUsd)}`})
						</span>
					</>
				) : null}
			</span>
		</Link>
	);
}

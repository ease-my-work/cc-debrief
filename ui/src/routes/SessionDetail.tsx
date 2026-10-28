// Session detail (feature 12; mockup Sessions.html, right pane): header, summary area, timeline and side facts.
// The summary area and its Summarize action are Phase 3; the review band is Phase 4 (Tier 1) and 5a (Tier 2).
import type { SessionDetail as Detail, Surface } from "@api-types";
import { useState } from "react";
import { ErrorCard } from "../components/ErrorCard";
import { Replay } from "../components/Replay";
import { ResumeButton } from "../components/ResumeButton";
import { ReviewBand } from "../components/ReviewBand";
import { SideFacts } from "../components/SideFacts";
import { SkeletonCard } from "../components/Skeleton";
import { SummaryBlock } from "../components/SummaryBlock";
import { Timeline } from "../components/Timeline";
import { TypeBadge } from "../components/TypeBadge";
import { clock, dayLabel, shortId } from "../lib/format";
import { useApi } from "../lib/useApi";

const SURFACE: Record<Surface, string> = { cli: "CLI", vscode: "VS Code", desktop: "desktop", unknown: "other" };

export function SessionDetailView({ id }: { id: string }) {
	const { data: d, error, reload } = useApi<Detail>(`/api/sessions/${encodeURIComponent(id)}`);
	const [replay, setReplay] = useState(false);
	if (error) return <ErrorCard error={error} onRetry={reload} />;
	if (!d) return <SkeletonCard height={420} />;

	const span = d.inProgress
		? `${clock(d.startedAt)} · running`
		: `${clock(d.startedAt)}–${d.endedAt ? clock(d.endedAt) : "?"}`;
	return (
		<article className="card flex flex-col overflow-hidden" aria-label="Session detail">
			<header className="flex flex-col gap-2.5 border-b border-row px-5 pt-4 pb-3">
				<div className="flex flex-wrap items-center gap-2.5">
					<TypeBadge type={d.type} source={d.typeSource} />
					{d.inProgress ? <span className="badge bg-accent-fill text-accent">In progress</span> : null}
					<span className="text-[12px] text-muted">
						{dayLabel(d.startedAt)} · {span} · {SURFACE[d.surface]} ·{" "}
						<span className="mono" title={d.id}>
							{shortId(d.id)}
						</span>
					</span>
					<span className="flex-grow" />
					<ResumeButton command={d.resumeCommand} />
				</div>
				<SummaryBlock d={d} onChanged={reload} />
			</header>
			{d.review ? <ReviewBand band={d.review} sessionId={d.id} imported={d.imported} onChanged={reload} /> : null}
			<div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_250px]">
				{replay ? (
					<Replay sessionId={d.id} onClose={() => setReplay(false)} />
				) : (
					<Timeline d={d} onReplay={d.turns.length > 0 ? () => setReplay(true) : undefined} />
				)}
				<SideFacts d={d} />
			</div>
		</article>
	);
}

// Session replay (Phase 7 P8, feature 12; mockup note in TasksPlans.html): every turn's prompt and full reply as
// Markdown with its tokens, cost and tools, a cumulative-token curve, turn filters and find in session. Loaded only
// when opened; the excerpt timeline stays the collapsed state.
import type { ReplayResponse, ReplayTurn } from "@api-types";
import { Fragment, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { compactTokens, num, usd } from "../lib/format";
import { useApi } from "../lib/useApi";
import { ErrorCard } from "./ErrorCard";
import { Markdown } from "./Markdown";
import { Skeleton } from "./Skeleton";

type Filter = "tools" | "failures" | "compactions" | "top";
const FILTERS: { key: Filter; label: string }[] = [
	{ key: "tools", label: "Tool calls" },
	{ key: "failures", label: "Failures" },
	{ key: "compactions", label: "Compactions" },
	{ key: "top", label: "Top 10% cost" },
];

/** Plain text with case-insensitive matches of `query` in <mark data-find>. */
function Highlighted({ text, query }: { text: string; query: string }): ReactNode {
	if (!query) return text;
	const lower = text.toLowerCase();
	const needle = query.toLowerCase();
	const out: ReactNode[] = [];
	let at = 0;
	for (let hit = lower.indexOf(needle); hit !== -1; hit = lower.indexOf(needle, at)) {
		if (hit > at) out.push(<Fragment key={`t${at}`}>{text.slice(at, hit)}</Fragment>);
		out.push(
			<mark key={`m${hit}`} data-find="">
				{text.slice(hit, hit + needle.length)}
			</mark>,
		);
		at = hit + needle.length;
	}
	out.push(<Fragment key={`t${at}`}>{text.slice(at)}</Fragment>);
	return out;
}

export function TokenCurve({ cumulative }: { cumulative: number[] }) {
	const max = Math.max(1, ...cumulative);
	const w = 600;
	const h = 80;
	const points = cumulative
		.map((v, i) => `${cumulative.length === 1 ? w : (i / (cumulative.length - 1)) * w},${h - (v / max) * h}`)
		.join(" ");
	return (
		<figure
			className="m-0"
			aria-label={`Cumulative tokens, ${cumulative.length} turns, ${compactTokens(cumulative.at(-1) ?? 0)} in total`}
		>
			<svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="h-[80px] w-full" aria-hidden="true">
				<polyline points={`0,${h} ${points}`} fill="none" stroke="var(--color-accent)" strokeWidth="2" />
			</svg>
		</figure>
	);
}

function tokenLine(t: ReplayTurn): string {
	const k = t.tokens;
	return `${compactTokens(k.input)} in · ${compactTokens(k.cacheWrite)} cache w · ${compactTokens(k.cacheRead)} cache r · ${compactTokens(k.output)} out · ${usd(t.costUsd)}`;
}

export function ReplayTurnCard({ t, query }: { t: ReplayTurn; query: string }) {
	return (
		<article aria-label={`Turn ${t.seq}`} className="flex flex-col gap-2 border-t border-row px-5 py-3.5">
			{t.compaction ? (
				<div className="flex items-center gap-2 text-[12px] text-muted">
					<span className="h-px flex-grow bg-border" />
					compacted before this turn
					<span className="h-px flex-grow bg-border" />
				</div>
			) : null}
			<div className="text-[13.5px] leading-normal break-words whitespace-pre-wrap">
				<span className="text-muted">You · </span>
				<Highlighted text={t.userText} query={query} />
			</div>
			{t.tools.length > 0 ? (
				<div className="flex flex-wrap gap-1.5">
					{t.tools.map((c) => (
						<span key={c.label} className="mono rounded-md bg-neutral-fill px-2 py-0.5 text-[12px] text-neutral-text">
							{c.label} ×{num(c.count)}
							{c.failures > 0 ? <span className="text-bad"> · {num(c.failures)} failed</span> : null}
						</span>
					))}
				</div>
			) : null}
			{t.assistantText ? <Markdown text={t.assistantText} highlight={query} /> : null}
			{t.truncated ? <div className="text-[12px] text-muted">reply cut at 32 KB</div> : null}
			<div className="mono text-[12px] text-muted">{tokenLine(t)}</div>
		</article>
	);
}

export function Replay({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
	const { data, error, reload } = useApi<ReplayResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/replay`);
	const [filters, setFilters] = useState<Set<Filter>>(new Set());
	const [query, setQuery] = useState("");
	const [count, setCount] = useState(0);
	const [current, setCurrent] = useState(0);
	const box = useRef<HTMLDivElement>(null);

	const shown = useMemo(() => {
		if (!data) return [];
		const costs = data.turns.map((t) => t.costUsd ?? 0).sort((a, b) => b - a);
		const cutoff = costs[Math.max(0, Math.ceil(costs.length * 0.1) - 1)] ?? 0;
		return data.turns.filter(
			(t) =>
				(!filters.has("tools") || t.tools.length > 0) &&
				(!filters.has("failures") || t.failures > 0) &&
				(!filters.has("compactions") || t.compaction) &&
				(!filters.has("top") || ((t.costUsd ?? 0) >= cutoff && cutoff > 0)),
		);
	}, [data, filters]);

	// Count the rendered matches; mark and scroll to the current one.
	// biome-ignore lint/correctness/useExhaustiveDependencies: recount when the shown turns or the query change
	useEffect(() => {
		const marks = [...(box.current?.querySelectorAll("mark[data-find]") ?? [])];
		setCount(marks.length);
		setCurrent((c) => (marks.length === 0 ? 0 : Math.min(c, marks.length - 1)));
	}, [shown, query]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: count changes when the marks were re-rendered
	useEffect(() => {
		const marks = [...(box.current?.querySelectorAll("mark[data-find]") ?? [])];
		marks.forEach((m, i) => {
			if (i === current) m.setAttribute("data-current", "");
			else m.removeAttribute("data-current");
		});
		marks[current]?.scrollIntoView?.({ block: "center" });
	}, [current, count]);

	const step = (d: number) => count > 0 && setCurrent((c) => (c + d + count) % count);
	const toggle = (f: Filter) =>
		setFilters((s) => {
			const next = new Set(s);
			if (next.has(f)) next.delete(f);
			else next.add(f);
			return next;
		});

	return (
		<section aria-label="Replay" className="flex flex-col">
			<div className="flex flex-wrap items-center gap-2 px-5 py-3.5">
				<div className="section-h flex-grow">Replay{data ? ` · ${data.turns.length} turns` : ""}</div>
				{FILTERS.map((f) => (
					<button
						key={f.key}
						type="button"
						aria-pressed={filters.has(f.key)}
						onClick={() => toggle(f.key)}
						className={`rounded-full border px-2.5 py-0.5 text-[12px] ${filters.has(f.key) ? "border-ink bg-ink text-panel" : "border-border bg-panel text-muted"}`}
					>
						{f.label}
					</button>
				))}
				<button type="button" onClick={onClose} className="border-0 bg-transparent p-0 text-[12px] text-accent">
					Close replay
				</button>
			</div>
			<div className="flex items-center gap-2 px-5 pb-2 text-[12.5px] text-muted">
				<input
					type="search"
					aria-label="Find in session"
					placeholder="Find in session"
					value={query}
					onChange={(e) => {
						setQuery(e.target.value);
						setCurrent(0);
					}}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							e.preventDefault();
							step(e.shiftKey ? -1 : 1);
						}
					}}
					className="w-[220px] rounded-md border border-border bg-panel px-2 py-1 text-[13px] text-ink"
				/>
				{query ? <span aria-live="polite">{count === 0 ? "no matches" : `${current + 1} of ${count}`}</span> : null}
				<button
					type="button"
					aria-label="Previous match"
					onClick={() => step(-1)}
					className="rounded border border-border bg-panel px-1.5"
				>
					↑
				</button>
				<button
					type="button"
					aria-label="Next match"
					onClick={() => step(1)}
					className="rounded border border-border bg-panel px-1.5"
				>
					↓
				</button>
			</div>
			{error ? <ErrorCard error={error} onRetry={reload} /> : null}
			{!data && !error ? <Skeleton height={200} /> : null}
			{data ? (
				<div ref={box}>
					<div className="px-5 pb-2">
						<TokenCurve cumulative={data.cumulative} />
					</div>
					{shown.map((t) => (
						<ReplayTurnCard key={t.seq} t={t} query={query.trim()} />
					))}
					{shown.length === 0 ? (
						<p className="m-0 border-t border-row px-5 py-3.5 text-[13px] text-muted">No turns match the filters.</p>
					) : null}
				</div>
			) : null}
		</section>
	);
}

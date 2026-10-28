// Sessions (feature 12; mockup Sessions.html): search (debounced 250 ms), repo and type filters, a 380 px master
// list with infinite scroll (50 per page) and arrow-key selection, and the detail of the selected session.
import type { Range, SessionListItem, SessionsResponse, SessionType } from "@api-types";
import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { type ApiErrorClass, getJson } from "../api";
import { EmptyState } from "../components/EmptyState";
import { ErrorCard } from "../components/ErrorCard";
import { ImportedSummariesBanner } from "../components/ImportedSummariesBanner";
import { RangeSelect } from "../components/RangeSelect";
import { RepoFilter } from "../components/RepoFilter";
import { SessionRow } from "../components/SessionRow";
import { Skeleton } from "../components/Skeleton";
import { TopBar } from "../components/TopBar";
import { num } from "../lib/format";
import { PHRASE } from "../lib/ranges";
import { useQueryParam, useRange, useRepoFilter } from "../lib/useFilters";
import { useIngestVersion, useStatus } from "../lib/useLiveRefresh";
import { SessionDetailView } from "./SessionDetail";

const PAGE = 50;
const DEBOUNCE_MS = 250;
const TYPES: SessionType[] = ["feature", "bugfix", "refactor", "exploration", "ops", "docs", "other"];

type Pages = {
	items: SessionListItem[];
	total: number;
	nextCursor: string | null;
	error: ApiErrorClass | null;
	loaded: boolean;
};

/**
 * Live refresh merges the newest page into what is loaded: its rows replace their loaded copies and rows not loaded
 * yet go on top, so pages already scrolled in stay (cursors are (started_at, id) positions, still valid).
 */
export function mergeFirstPage(loaded: SessionListItem[], fresh: SessionListItem[]): SessionListItem[] {
	const loadedIds = new Set(loaded.map((s) => s.id));
	const byId = new Map(fresh.map((s) => [s.id, s]));
	return [...fresh.filter((s) => !loadedIds.has(s.id)), ...loaded.map((s) => byId.get(s.id) ?? s)];
}

/** First page on any filter change (reset); live refresh merges the first page; loadMore() appends the next. */
function useSessionPages(filters: { range: Range; repo: string | null; type: string | null; q: string | null }) {
	const [state, setState] = useState<Pages>({ items: [], total: 0, nextCursor: null, error: null, loaded: false });
	const [nonce, setNonce] = useState(0);
	const version = useIngestVersion();
	const seenVersion = useRef(version);
	const request = useRef(0);
	const loadingMore = useRef(false);
	const key = JSON.stringify(filters);

	// biome-ignore lint/correctness/useExhaustiveDependencies: key and nonce are the triggers
	useEffect(() => {
		const id = ++request.current;
		getJson<SessionsResponse>("/api/sessions", { ...filters, limit: PAGE })
			.then((r) => {
				if (id === request.current) setState({ ...r, error: null, loaded: true });
			})
			.catch((error: ApiErrorClass) => {
				if (id === request.current) setState((s) => ({ ...s, error, loaded: true }));
			});
	}, [key, nonce]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: version is the trigger
	useEffect(() => {
		if (version === seenVersion.current) return;
		seenVersion.current = version;
		const id = request.current; // a filter change since then wins
		getJson<SessionsResponse>("/api/sessions", { ...filters, limit: PAGE })
			.then((r) => {
				if (id !== request.current) return;
				setState((s) =>
					s.loaded
						? { ...s, items: mergeFirstPage(s.items, r.items), total: r.total, error: null }
						: { ...r, error: null, loaded: true },
				);
			})
			.catch(() => {
				// Keep the list; the next refresh tries again.
			});
	}, [version]);

	const loadMore = useCallback(() => {
		if (!state.nextCursor || loadingMore.current) return;
		loadingMore.current = true;
		const id = request.current;
		getJson<SessionsResponse>("/api/sessions", { ...filters, limit: PAGE, cursor: state.nextCursor })
			.then((r) => {
				if (id === request.current)
					setState((s) => ({ ...s, items: [...s.items, ...r.items], nextCursor: r.nextCursor, total: r.total }));
			})
			.catch((error: ApiErrorClass) => setState((s) => ({ ...s, error })))
			.finally(() => {
				loadingMore.current = false;
			});
	}, [state.nextCursor, filters]);

	return { ...state, loadMore, reload: () => setNonce((n) => n + 1) };
}

export function Sessions({ id }: { id?: string }) {
	const [range, setRange] = useRange("sessions", "7d");
	const [repo, setRepo] = useRepoFilter();
	const [type, setType] = useQueryParam("type");
	const [q, setQ] = useQueryParam("q");
	const [draft, setDraft] = useState(q ?? "");
	const [, navigate] = useLocation();
	const search = useSearch();
	const status = useStatus();
	// Stable filters, so loadMore and the scroll observer are not rebuilt on every render.
	const filters = useMemo(() => ({ range, repo, type, q }), [range, repo, type, q]);
	const list = useSessionPages(filters);
	const sentinel = useRef<HTMLDivElement>(null);

	// Search runs once typing stops.
	useEffect(() => {
		if (draft === (q ?? "")) return;
		const t = setTimeout(() => setQ(draft.trim() || null), DEBOUNCE_MS);
		return () => clearTimeout(t);
	}, [draft, q, setQ]);

	// Infinite scroll: the sentinel under the last row loads the next page.
	const { loadMore } = list;
	useEffect(() => {
		const el = sentinel.current;
		if (!el || typeof IntersectionObserver === "undefined") return;
		const io = new IntersectionObserver((entries) => {
			if (entries.some((e) => e.isIntersecting)) loadMore();
		});
		io.observe(el);
		return () => io.disconnect();
	}, [loadMore]);

	// Arrow keys replace the history entry, so Back leaves the list instead of stepping through every row.
	const go = (sid: string) => {
		navigate(`/sessions/${sid}${search ? `?${search}` : ""}`, { replace: id !== undefined });
		document.getElementById(`session-${sid}`)?.scrollIntoView?.({ block: "nearest" });
	};
	const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
		if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
		e.preventDefault();
		const at = list.items.findIndex((s) => s.id === id);
		const next = e.key === "ArrowDown" ? Math.min(at + 1, list.items.length - 1) : Math.max(at - 1, 0);
		const target = list.items[at === -1 ? 0 : next];
		if (target) go(target.id);
	};

	const top = (
		<TopBar title="Sessions">
			<label className="flex w-[300px] items-center gap-2 rounded-lg border border-border bg-panel px-3 py-1.5 text-[13px] focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-accent">
				<svg
					width="14"
					height="14"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					aria-hidden="true"
				>
					<circle cx="11" cy="11" r="7" />
					<path d="m20 20-3.5-3.5" />
				</svg>
				<input
					type="search"
					aria-label="Search prompts and summaries"
					placeholder="Search prompts and summaries"
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					className="min-w-0 flex-grow border-0 bg-transparent text-ink outline-none"
				/>
			</label>
			<RangeSelect value={range} onChange={setRange} />
			<RepoFilter value={repo} onChange={setRepo} />
			<select
				aria-label="Session type"
				value={type ?? ""}
				onChange={(e) => setType(e.target.value || null)}
				className="rounded-lg border border-border bg-panel px-3 py-1.5 text-[13px] text-ink"
			>
				<option value="">All types</option>
				{TYPES.map((t) => (
					<option key={t} value={t}>
						{t}
					</option>
				))}
			</select>
		</TopBar>
	);

	if (list.loaded && list.total === 0 && !q && !type && status?.lastIngestAt === null) {
		return (
			<>
				{top}
				<EmptyState />
			</>
		);
	}

	return (
		<>
			{top}
			<ImportedSummariesBanner onFinished={list.reload} />
			<div className="grid min-h-0 grid-cols-[380px_minmax(0,1fr)] items-start gap-4">
				<div className="card flex max-h-[calc(100vh-120px)] flex-col overflow-hidden">
					<div className="border-b border-row px-3.5 pt-3 pb-2 text-[12px] text-muted">
						{num(list.total)} sessions · {PHRASE[range]}
					</div>
					{list.error ? <ErrorCard error={list.error} onRetry={list.reload} /> : null}
					<div
						role="listbox"
						aria-label="Sessions"
						aria-activedescendant={id ? `session-${id}` : undefined}
						tabIndex={0}
						onKeyDown={onKeyDown}
						className="flex flex-col overflow-y-auto outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
					>
						{!list.loaded
							? [0, 1, 2, 3].map((i) => (
									<div key={i} className="border-b border-row px-3.5 py-3">
										<Skeleton height={44} />
									</div>
								))
							: list.items.map((s) => <SessionRow key={s.id} s={s} selected={s.id === id} />)}
						{list.loaded && list.items.length === 0 && !list.error ? (
							<p className="m-0 px-3.5 py-6 text-[13px] text-muted">No sessions match.</p>
						) : null}
						<div ref={sentinel} aria-hidden="true" className="h-px" />
					</div>
				</div>
				{id ? (
					<SessionDetailView key={id} id={id} />
				) : (
					<div className="card px-5 py-10 text-center text-[13px] text-muted">Select a session</div>
				)}
			</div>
		</>
	);
}

// The command palette (Phase 7 P14, feature 12): views, sessions (the Sessions search, top 8), repos, skills and
// tools in one list. Enter opens the active item, Esc closes, Tab keeps focus in the dialog, and focus goes back to
// where it was. Opened by Ctrl/Cmd-K (KeyboardShortcuts).
import type { InventoryResponse, ReposResponse, SessionsResponse, ToolsResponse } from "@api-types";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { getJson } from "../api";

export const VIEWS: { label: string; href: string; key: string }[] = [
	{ label: "Overview", href: "/", key: "o" },
	{ label: "Activity", href: "/activity", key: "a" },
	{ label: "Costs", href: "/costs", key: "c" },
	{ label: "Sessions", href: "/sessions", key: "s" },
	{ label: "Recap", href: "/recap", key: "" },
	{ label: "Repos", href: "/repos", key: "r" },
	{ label: "Tasks & plans", href: "/tasks", key: "t" },
	{ label: "Skills & Tools", href: "/skills", key: "k" },
	{ label: "Settings", href: "/settings", key: "e" },
];

const PER_GROUP = 5;
const SESSION_HITS = 8;
const DEBOUNCE_MS = 200;

type Item = { id: string; group: string; label: string; detail: string; href: string };
type Catalog = { repos: Item[]; skills: Item[]; tools: Item[] };

async function loadCatalog(): Promise<Catalog> {
	const [repos, skills, tools] = await Promise.all([
		getJson<ReposResponse>("/api/repos", { range: "all" }).catch(() => null),
		getJson<InventoryResponse>("/api/inventory", { kind: "skill", range: "all" }).catch(() => null),
		getJson<ToolsResponse>("/api/tools", { range: "all" }).catch(() => null),
	]);
	return {
		repos: (repos?.repos ?? []).map((r) => ({
			id: `repo:${r.id}`,
			group: "Repos",
			label: r.name,
			detail: "repo",
			href: `/repos/${encodeURIComponent(r.id)}`,
		})),
		skills: (skills?.items ?? []).map((s) => ({
			id: `skill:${s.id}`,
			group: "Skills",
			label: s.name,
			detail: "skill",
			href: "/skills",
		})),
		tools: (tools?.tools ?? []).map((t) => ({
			id: `tool:${t.name}`,
			group: "Tools",
			label: t.name,
			detail: "tool",
			href: "/skills?tab=tools",
		})),
	};
}

export function CommandPalette({ onClose }: { onClose: () => void }) {
	const [, navigate] = useLocation();
	const [query, setQuery] = useState("");
	const [active, setActive] = useState(0);
	const [catalog, setCatalog] = useState<Catalog>({ repos: [], skills: [], tools: [] });
	const [sessions, setSessions] = useState<Item[]>([]);
	const input = useRef<HTMLInputElement>(null);

	useEffect(() => {
		input.current?.focus();
		let live = true;
		void loadCatalog().then((c) => live && setCatalog(c));
		return () => {
			live = false;
		};
	}, []);

	// Sessions come from the Sessions search (prompt, summary, title), debounced.
	useEffect(() => {
		const q = query.trim();
		if (!q) {
			setSessions([]);
			return;
		}
		let live = true;
		const t = setTimeout(() => {
			void getJson<SessionsResponse>("/api/sessions", { q, range: "all", limit: SESSION_HITS })
				.then((r) => {
					if (!live) return;
					setSessions(
						r.items.map((s) => ({
							id: `session:${s.id}`,
							group: "Sessions",
							label: s.summaryLine ?? s.id,
							detail: s.repo?.name ?? "session",
							href: `/sessions/${encodeURIComponent(s.id)}`,
						})),
					);
				})
				.catch(() => live && setSessions([]));
		}, DEBOUNCE_MS);
		return () => {
			live = false;
			clearTimeout(t);
		};
	}, [query]);

	const items = useMemo(() => {
		const q = query.trim().toLowerCase();
		const match = (i: { label: string }) => i.label.toLowerCase().includes(q);
		const views = VIEWS.filter((v) => !q || v.label.toLowerCase().includes(q)).map((v) => ({
			id: `view:${v.href}`,
			group: "Views",
			label: v.label,
			detail: "view",
			href: v.href,
		}));
		if (!q) return views;
		return [
			...views,
			...sessions,
			...catalog.repos.filter(match).slice(0, PER_GROUP),
			...catalog.skills.filter(match).slice(0, PER_GROUP),
			...catalog.tools.filter(match).slice(0, PER_GROUP),
		];
	}, [query, sessions, catalog]);
	useEffect(() => setActive((a) => Math.min(a, Math.max(0, items.length - 1))), [items]);

	const open = (i: Item | undefined) => {
		if (!i) return;
		onClose();
		navigate(i.href);
	};
	const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
		if (e.key === "Escape") {
			e.preventDefault();
			onClose();
		} else if (e.key === "Tab") {
			e.preventDefault(); // the field is the dialog's only stop: focus stays here
			input.current?.focus();
		} else if (e.key === "ArrowDown") {
			e.preventDefault();
			setActive((a) => Math.min(a + 1, items.length - 1));
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			setActive((a) => Math.max(a - 1, 0));
		} else if (e.key === "Enter") {
			e.preventDefault();
			open(items[active]);
		}
	};

	let lastGroup = "";
	return (
		<div className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh]">
			<button
				type="button"
				tabIndex={-1}
				aria-label="Close command palette"
				onClick={onClose}
				className="absolute inset-0 cursor-default border-0 bg-black/30"
			/>
			<div
				role="dialog"
				aria-modal="true"
				aria-label="Command palette"
				onKeyDown={onKeyDown}
				className="card relative w-[560px] max-w-[calc(100vw-32px)] overflow-hidden shadow-xl"
			>
				<input
					ref={input}
					role="combobox"
					aria-label="Search everything"
					aria-expanded="true"
					aria-controls="palette-list"
					aria-activedescendant={items[active] ? `palette-${active}` : undefined}
					placeholder="Search views, sessions, repos, skills, tools"
					value={query}
					onChange={(e) => {
						setQuery(e.target.value);
						setActive(0);
					}}
					className="w-full border-0 border-b border-border bg-panel px-4 py-3 text-[14px] text-ink outline-none"
				/>
				<div id="palette-list" role="listbox" aria-label="Results" className="max-h-[50vh] overflow-y-auto py-1">
					{items.length === 0 ? <div className="px-4 py-3 text-[13px] text-muted">No matches</div> : null}
					{items.map((i, n) => {
						const heading = i.group !== lastGroup;
						lastGroup = i.group;
						return (
							<div key={i.id}>
								{heading ? <div className="section-h px-4 pt-2 pb-1">{i.group}</div> : null}
								<div
									id={`palette-${n}`}
									role="option"
									aria-selected={n === active}
									tabIndex={-1}
									onMouseEnter={() => setActive(n)}
									onClick={() => open(i)}
									onKeyDown={() => {}}
									className={`flex cursor-pointer items-center gap-2 px-4 py-1.5 text-[13.5px] ${n === active ? "bg-accent-fill" : ""}`}
								>
									<span className="min-w-0 flex-grow truncate">{i.label}</span>
									<span className="text-[12px] text-muted">{i.detail}</span>
								</div>
							</div>
						);
					})}
				</div>
			</div>
		</div>
	);
}

// Keyboard shortcuts (Phase 7 P14, feature 12): Ctrl/Cmd-K opens the command palette anywhere; outside fields, "g"
// then a letter opens a view, j / k move through list rows (Enter opens), "/" focuses the view's search and "?"
// lists the keys.
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { CommandPalette, VIEWS } from "./CommandPalette";

const G_WINDOW_MS = 1500;

const typing = (t: EventTarget | null) =>
	t instanceof HTMLElement &&
	(t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT");

/** Moves focus to the next (+1) or previous (−1) [data-nav-item] row on the page. */
function moveInList(step: 1 | -1): void {
	const rows = [...document.querySelectorAll<HTMLElement>("[data-nav-item]")];
	if (rows.length === 0) return;
	const at = rows.findIndex((r) => r === document.activeElement || r.contains(document.activeElement));
	const next = at === -1 ? 0 : Math.min(rows.length - 1, Math.max(0, at + step));
	rows[next].focus();
	rows[next].scrollIntoView?.({ block: "nearest" });
}

function KeyList({ onClose }: { onClose: () => void }) {
	const close = useRef<HTMLButtonElement>(null);
	useEffect(() => close.current?.focus(), []);
	const row = (keys: ReactNode, what: string) => (
		<tr key={what}>
			<td className="py-1 pr-4">{keys}</td>
			<td className="py-1">{what}</td>
		</tr>
	);
	const kbd = (k: string) => (
		<kbd className="mono rounded border border-border border-b-2 bg-panel px-1.5 text-[12px]">{k}</kbd>
	);
	return (
		<div className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh]">
			<button
				type="button"
				tabIndex={-1}
				aria-label="Close keyboard shortcuts"
				onClick={onClose}
				className="absolute inset-0 cursor-default border-0 bg-black/30"
			/>
			<div
				role="dialog"
				aria-modal="true"
				aria-label="Keyboard shortcuts"
				onKeyDown={(e) => {
					if (e.key === "Escape" || e.key === "?") {
						e.preventDefault();
						onClose();
					}
				}}
				className="card relative w-[420px] max-w-[calc(100vw-32px)] px-5 py-4"
			>
				<div className="mb-2 flex items-center">
					<div className="section-h flex-grow">Keyboard shortcuts</div>
					<button
						ref={close}
						type="button"
						onClick={onClose}
						className="border-0 bg-transparent p-0 text-[12px] text-accent"
					>
						Close
					</button>
				</div>
				<table className="w-full text-[13px]">
					<tbody>
						{row(
							<>
								{kbd("Ctrl")} {kbd("K")}
							</>,
							"Search everything",
						)}
						{VIEWS.filter((v) => v.key).map((v) =>
							row(
								<>
									{kbd("g")} {kbd(v.key)}
								</>,
								v.label,
							),
						)}
						{row(
							<>
								{kbd("j")} {kbd("k")}
							</>,
							"Next / previous row, Enter opens",
						)}
						{row(kbd("/"), "Search this view")}
						{row(kbd("?"), "This list")}
					</tbody>
				</table>
			</div>
		</div>
	);
}

export function KeyboardShortcuts() {
	const [, navigate] = useLocation();
	const [palette, setPalette] = useState(false);
	const [keys, setKeys] = useState(false);
	const gAt = useRef(0);
	const restore = useRef<HTMLElement | null>(null);

	const openDialog = useCallback((set: (v: boolean) => void) => {
		restore.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		set(true);
	}, []);
	const closeDialog = (set: (v: boolean) => void) => {
		set(false);
		const el = restore.current;
		restore.current = null;
		// After the dialog unmounts.
		setTimeout(() => el?.isConnected && el.focus(), 0);
	};

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "k") {
				e.preventDefault();
				if (!palette) openDialog(setPalette);
				return;
			}
			if (palette || keys || e.ctrlKey || e.metaKey || e.altKey || typing(e.target)) return;
			if (Date.now() - gAt.current < G_WINDOW_MS) {
				gAt.current = 0;
				const view = VIEWS.find((v) => v.key && v.key === e.key);
				if (view) {
					e.preventDefault();
					navigate(view.href);
				}
				return;
			}
			if (e.key === "g") {
				gAt.current = Date.now();
			} else if (e.key === "j" || e.key === "k") {
				e.preventDefault();
				moveInList(e.key === "j" ? 1 : -1);
			} else if (e.key === "/") {
				const search = document.querySelector<HTMLInputElement>('main input[type="search"]');
				if (search) {
					e.preventDefault();
					search.focus();
				}
			} else if (e.key === "?") {
				e.preventDefault();
				openDialog(setKeys);
			}
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [palette, keys, navigate, openDialog]);

	return (
		<>
			{palette ? <CommandPalette onClose={() => closeDialog(setPalette)} /> : null}
			{keys ? <KeyList onClose={() => closeDialog(setKeys)} /> : null}
		</>
	);
}

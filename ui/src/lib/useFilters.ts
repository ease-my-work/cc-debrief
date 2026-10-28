// Filters live in the URL query (reloads and shared links keep them); the last choice is mirrored in localStorage
// as a convenience (feature 12). The repo filter is shared across views.
import type { Range } from "@api-types";
import { useCallback } from "react";
import { useLocation, useSearch } from "wouter";
import { RANGES } from "./ranges";

function stored(key: string): string | null {
	try {
		return window.localStorage.getItem(`cc-debrief.${key}`);
	} catch {
		return null;
	}
}
function store(key: string, value: string | null): void {
	try {
		if (value === null) window.localStorage.removeItem(`cc-debrief.${key}`);
		else window.localStorage.setItem(`cc-debrief.${key}`, value);
	} catch {
		// Private windows can refuse storage; the URL still holds the filter.
	}
}

/** A query parameter of the current URL with a setter that replaces the history entry. */
export function useQueryParam(name: string): [string | null, (value: string | null) => void] {
	const search = useSearch();
	const [location, navigate] = useLocation();
	const value = new URLSearchParams(search).get(name);
	const set = useCallback(
		(v: string | null) => {
			const q = new URLSearchParams(window.location.search);
			if (v === null || v === "") q.delete(name);
			else q.set(name, v);
			const s = q.toString();
			navigate(s ? `${location}?${s}` : location, { replace: true });
		},
		[name, location, navigate],
	);
	return [value, set];
}

/** The view's range: URL, else the last choice for this view, else the view's default. */
export function useRange(view: string, fallback: Range): [Range, (r: Range) => void] {
	const [value, set] = useQueryParam("range");
	const pick = (v: string | null) => (v && (RANGES as string[]).includes(v) ? (v as Range) : null);
	const range = pick(value) ?? pick(stored(`range.${view}`)) ?? fallback;
	const setRange = useCallback(
		(r: Range) => {
			store(`range.${view}`, r);
			set(r);
		},
		[view, set],
	);
	return [range, setRange];
}

/** The repo filter, shared across views: URL, else the last choice. */
export function useRepoFilter(): [string | null, (repo: string | null) => void] {
	const [value, set] = useQueryParam("repo");
	const repo = value ?? stored("repo");
	const setRepo = useCallback(
		(r: string | null) => {
			store("repo", r);
			set(r);
		},
		[set],
	);
	return [repo, setRepo];
}

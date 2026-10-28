// Disk use of Claude Code's own transcripts (Phase 7 P11): the size of ~/.claude/projects, shown next to tracker.db in
// Settings and doctor. The walk stops after a time budget and then reports "at least".
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { projectsDir } from "../paths";

export type SizeResult = { bytes: number; cut: boolean };

const BUDGET_MS = 2000;
const CACHE_MS = 60_000;

/** Bytes of every regular file under `root` (symlinks not followed), stopping once `budgetMs` has passed. */
export function dirSize(root: string, budgetMs: number = BUDGET_MS): SizeResult {
	const deadline = performance.now() + budgetMs;
	let bytes = 0;
	const stack = [root];
	while (stack.length > 0) {
		if (performance.now() >= deadline) return { bytes, cut: true };
		const dir = stack.pop() as string;
		let names: string[];
		try {
			names = readdirSync(dir);
		} catch {
			continue;
		}
		for (const n of names) {
			const p = join(dir, n);
			try {
				const s = statSync(p, { throwIfNoEntry: false });
				if (!s) continue;
				if (s.isDirectory()) stack.push(p);
				else if (s.isFile()) bytes += s.size;
			} catch {
				// unreadable entry
			}
		}
	}
	return { bytes, cut: false };
}

let cached: { at: number; value: SizeResult } | null = null;

/** The size of ~/.claude/projects, cached for a minute (Settings reloads its config often). */
export function projectsSize(opts: { fresh?: boolean } = {}): SizeResult {
	if (!opts.fresh && cached && Date.now() - cached.at < CACHE_MS) return cached.value;
	const value = dirSize(projectsDir());
	cached = { at: Date.now(), value };
	return value;
}

const UNITS = ["B", "KB", "MB", "GB", "TB"];

/** 12 B, 1.5 KB, 3.0 GB; "≥ " when the walk was cut. */
export function formatBytes(r: SizeResult): string {
	let v = r.bytes;
	let u = 0;
	while (v >= 1024 && u < UNITS.length - 1) {
		v /= 1024;
		u++;
	}
	return `${r.cut ? "≥ " : ""}${u === 0 ? String(v) : v.toFixed(1)} ${UNITS[u]}`;
}

// A repo's Claude Code auto-memory files (Phase 7 P12, feature 12): ~/.claude/projects/<slug>/memory/*.md, read on
// request and never stored or written. The slug is Claude Code's project folder name for the repo root: every
// character other than a letter or digit becomes "-" (C:\code\my.repo → C--code-my-repo).
import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { projectsDir } from "../paths";

/** Files over this are cut, and the view says so. */
export const MEMORY_MAX_BYTES = 64 * 1024;

export type MemoryFile = { name: string; size: number; mtime: string; truncated: boolean };

export const projectSlug = (rootPath: string): string => rootPath.replace(/[^A-Za-z0-9]/g, "-");

/** The project folder's memory dir; on Windows the folder may differ in case (drive letter), so match it loosely. */
function memoryDir(rootPath: string): string | null {
	const slug = projectSlug(rootPath);
	let names: string[];
	try {
		names = readdirSync(projectsDir());
	} catch {
		return null;
	}
	const hit = names.find((n) => n === slug) ?? names.find((n) => n.toLowerCase() === slug.toLowerCase());
	return hit ? join(projectsDir(), hit, "memory") : null;
}

/** A plain file name: no separator, no "..", not empty. */
export const validMemoryName = (name: string): boolean =>
	name.length > 0 && name.length <= 255 && !/[\\/]/.test(name) && name !== "." && !name.includes("..");

export function listMemoryFiles(rootPath: string): MemoryFile[] {
	const dir = memoryDir(rootPath);
	if (!dir) return [];
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	const out: MemoryFile[] = [];
	for (const name of names) {
		if (!name.toLowerCase().endsWith(".md")) continue;
		try {
			const s = statSync(join(dir, name));
			if (!s.isFile()) continue;
			out.push({ name, size: s.size, mtime: s.mtime.toISOString(), truncated: s.size > MEMORY_MAX_BYTES });
		} catch {
			// gone between the listing and the stat
		}
	}
	// MEMORY.md (the index) first, then by name.
	return out.sort(
		(a, b) => Number(b.name === "MEMORY.md") - Number(a.name === "MEMORY.md") || a.name.localeCompare(b.name),
	);
}

/** The file's text, cut at MEMORY_MAX_BYTES; null when it does not exist (or the name is not a plain file name). */
export function readMemoryFile(rootPath: string, name: string): { text: string; truncated: boolean } | null {
	if (!validMemoryName(name)) return null;
	const dir = memoryDir(rootPath);
	if (!dir) return null;
	const path = join(dir, name);
	let fd: number;
	try {
		if (!statSync(path).isFile()) return null;
		fd = openSync(path, "r");
	} catch {
		return null;
	}
	try {
		const size = statSync(path).size;
		const buf = Buffer.alloc(Math.min(size, MEMORY_MAX_BYTES));
		const read = readSync(fd, buf, 0, buf.length, 0);
		return { text: buf.subarray(0, read).toString("utf8"), truncated: size > MEMORY_MAX_BYTES };
	} finally {
		closeSync(fd);
	}
}

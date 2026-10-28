// Per-session lock files: <locksDir>/<sessionId>.lock holding { pid, startedAt }. snapshot, ingest and enrich
// take one so two workers never ingest or derive the same session at once.
import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { ensureDir, locksDir } from "./paths";

const SESSION_ID = /^[A-Za-z0-9-]{1,100}$/;
const STALE_MS = 10 * 60_000;
const POLL_MS = 50;

type Owner = { pid: number; startedAt: string };

// Sessions whose lock this process holds now. Our derives are synchronous, so code in this process may derive such a
// session (it cannot interleave with another synchronous derive here); other processes are kept out by the file.
const held = new Set<string>();

function tryCreate(path: string, owner: Owner): boolean {
	let fd: number;
	try {
		fd = openSync(path, "wx", 0o600);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw e;
	}
	try {
		writeSync(fd, JSON.stringify(owner));
	} finally {
		closeSync(fd);
	}
	return true;
}

function readLock(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null; // released meanwhile
	}
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code !== "ESRCH"; // EPERM: alive, owned by someone else
	}
}

function isStale(path: string, text: string): boolean {
	try {
		const { pid, startedAt } = JSON.parse(text) as Owner;
		const age = Date.now() - Date.parse(startedAt);
		return !Number.isInteger(pid) || !pidAlive(pid) || !(age <= STALE_MS);
	} catch {
		// Empty or partial: the owner may still be writing it; judge by file age instead.
		try {
			return Date.now() - statSync(path).mtimeMs > STALE_MS;
		} catch {
			return false;
		}
	}
}

// Removes a stale lock, unless it changed since it was judged (another worker took it over first).
function removeIfUnchanged(path: string, judged: string): void {
	if (readLock(path) !== judged) return;
	try {
		unlinkSync(path);
	} catch {
		// already gone
	}
}

/**
 * Runs fn while holding the session's lock. Tries for up to waitMs (0 = once) and returns "busy" if another
 * live worker keeps it. A lock whose pid is gone, or that is older than 10 min, is taken over.
 */
export async function withSessionLock<T>(
	sessionId: string,
	opts: { waitMs: number },
	fn: () => Promise<T>,
): Promise<T | "busy"> {
	if (!SESSION_ID.test(sessionId)) throw new Error(`invalid session id: ${JSON.stringify(sessionId)}`);
	ensureDir(locksDir());
	const path = join(locksDir(), `${sessionId}.lock`);
	const owner: Owner = { pid: process.pid, startedAt: new Date().toISOString() };
	const mine = JSON.stringify(owner);
	const deadline = Date.now() + opts.waitMs;

	let quickRetries = 0;
	for (;;) {
		if (tryCreate(path, owner)) break;
		const text = readLock(path);
		const stale = text !== null && isStale(path, text);
		if (stale) removeIfUnchanged(path, text);
		// Released or stale: retry at once, but never spin forever (an unremovable file waits like a live lock).
		if ((text === null || stale) && quickRetries++ < 20) continue;
		const left = deadline - Date.now();
		if (left <= 0) return "busy";
		await new Promise((r) => setTimeout(r, Math.min(POLL_MS, left)));
	}

	held.add(sessionId);
	try {
		return await fn();
	} finally {
		held.delete(sessionId);
		// Only remove our own lock: after 10 min another worker may have taken it over.
		removeIfUnchanged(path, mine);
	}
}

/** Whether a live worker (this process included) holds the lock now; a stale lock does not count. */
export function sessionLockHeld(sessionId: string): boolean {
	if (!SESSION_ID.test(sessionId)) return false;
	if (held.has(sessionId)) return true;
	const path = join(locksDir(), `${sessionId}.lock`);
	const text = readLock(path);
	return text !== null && !isStale(path, text);
}

/**
 * One synchronous try for the session's lock (a stale one is taken over), for synchronous code such as the rederive
 * drain. Returns the release function, a no-op one when this process already holds the lock, or null when another
 * live worker holds it.
 */
export function trySessionLockSync(sessionId: string): (() => void) | null {
	if (!SESSION_ID.test(sessionId)) throw new Error(`invalid session id: ${JSON.stringify(sessionId)}`);
	if (held.has(sessionId)) return () => {};
	ensureDir(locksDir());
	const path = join(locksDir(), `${sessionId}.lock`);
	const owner: Owner = { pid: process.pid, startedAt: new Date().toISOString() };
	const mine = JSON.stringify(owner);
	for (let attempt = 0; ; attempt++) {
		if (tryCreate(path, owner)) break;
		const text = readLock(path);
		const stale = text !== null && isStale(path, text);
		if (stale) removeIfUnchanged(path, text);
		if (!(text === null || stale) || attempt >= 20) return null;
	}
	held.add(sessionId);
	return () => {
		held.delete(sessionId);
		removeIfUnchanged(path, mine);
	};
}

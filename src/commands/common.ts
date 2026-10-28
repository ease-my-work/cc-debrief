// Helpers shared by the commands: output, the --from-hook quiet mode, DB access and number / path formatting.
import { homedir } from "node:os";
import { InvalidArgumentError } from "commander";
import { type Db, openDb } from "../db/adapter";
import { migrate } from "../db/migrate";
import { logHookError } from "../hook/errors";
import { SESSION_ID } from "../hook/run";

export type Out = (line: string) => void;

/** A usage error found by the command itself (not commander): message on stderr, exit 2. */
export class UsageError extends Error {}

/** Thrown by a command that has printed its own result and ends with a non-zero exit code (doctor). */
export class ExitCode extends Error {
	constructor(readonly code: number) {
		super(`exit ${code}`);
	}
}
export const stdout: Out = (line) => void process.stdout.write(`${line}\n`);

/**
 * Runs a command body. With --from-hook (a worker spawned by hook.js) nothing reaches stdout / stderr and the exit
 * code stays 0: errors go to hook-errors.log under the command's name.
 */
export async function quietly(name: string, fromHook: boolean | undefined, fn: () => Promise<void>): Promise<void> {
	if (!fromHook) return fn();
	try {
		await fn();
	} catch (e) {
		logHookError(e, name);
	}
}

/** Opens and migrates the DB for the length of fn. */
export async function withDb<T>(fn: (db: Db) => Promise<T> | T): Promise<T> {
	const db = openDb();
	try {
		migrate(db);
		return await fn(db);
	} finally {
		db.close();
	}
}

export function checkSessionId(id: string): string {
	if (!SESSION_ID.test(id)) throw new Error(`not a session id: ${JSON.stringify(id)}`);
	return id;
}

export const count = (n: number, word: string, plural = `${word}s`) =>
	`${n.toLocaleString("en-US")} ${n === 1 ? word : plural}`;

/** The path with the home directory shown as ~. */
export function tilde(raw: string): string {
	const home = homedir();
	const win = process.platform === "win32";
	const path = win ? raw.replaceAll("/", "\\") : raw;
	const head = path.slice(0, home.length);
	const same = win ? head.toLowerCase() === home.toLowerCase() : head === home;
	const next = path.charAt(home.length);
	const inside = home !== "" && same && (next === "" || next === "/" || (win && next === "\\"));
	return inside ? `~${path.slice(home.length)}` : path;
}

// commander argument parsers: a bad value is a usage error (exit 2).
export function parseDate(value: string): Date {
	const d = new Date(value);
	if (Number.isNaN(d.getTime())) throw new InvalidArgumentError("not a date (use YYYY-MM-DD or an ISO time)");
	return d;
}

export function parsePositiveInt(value: string): number {
	const n = Number(value);
	if (!Number.isInteger(n) || n < 1) throw new InvalidArgumentError("not a positive whole number");
	return n;
}

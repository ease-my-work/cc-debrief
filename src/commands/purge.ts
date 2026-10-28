import { rmSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import { loadConfig } from "../config";
import { type PurgeCounts, purgeAll, purgeOlderThan } from "../db/queries/retention";
import { dataDir, hookErrorsLogPath, rawDir } from "../paths";
import { count, type Out, stdout, tilde, UsageError, withDb } from "./common";

const DAY_MS = 86_400_000;

export type PurgeOptions = {
	all?: boolean;
	yes?: boolean;
	dryRun?: boolean;
	out?: Out;
	/** Whether stdin / stdout are a terminal (default: both are). */
	tty?: boolean;
	/** Asks the user; default reads a line from the terminal. */
	confirm?: (question: string) => Promise<boolean>;
	now?: Date;
};

async function askTerminal(question: string): Promise<boolean> {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		return /^y(es)?$/i.test((await rl.question(question)).trim());
	} finally {
		rl.close();
	}
}

const detail = (c: PurgeCounts) =>
	`${count(c.transcript_lines ?? 0, "transcript line")}, ${(c.bytes / 1e6).toFixed(1)} MB`;

/** `purge`: retention now (or everything with --all), then VACUUM. Returns false when the user declined. */
export async function runPurge(opts: PurgeOptions = {}): Promise<boolean> {
	const out = opts.out ?? stdout;
	const dryRun = opts.dryRun ?? false;
	if (opts.all && !opts.yes && !dryRun) {
		const tty = opts.tty ?? (process.stdin.isTTY === true && process.stdout.isTTY === true);
		if (!tty) throw new UsageError("purge --all deletes all tracker data; add --yes to confirm outside a terminal");
		const ok = await (opts.confirm ?? askTerminal)(
			`Delete all cc-debrief data in ${tilde(dataDir())} (config.json and drafts/ are kept)? [y/N] `,
		);
		if (!ok) {
			out("nothing deleted");
			return false;
		}
	}
	return withDb((db) => {
		if (opts.all) {
			const c = purgeAll(db, { now: opts.now, dryRun });
			const sessions = count(c.sessions, "session");
			if (dryRun) {
				out(`would delete everything: ${sessions} (${detail(c)})`);
				return true;
			}
			rmSync(rawDir(), { recursive: true, force: true });
			try {
				writeFileSync(hookErrorsLogPath(), "");
			} catch {
				// no data dir yet
			}
			db.exec("VACUUM");
			out(`deleted everything: ${sessions} (${detail(c)})`);
			out("kept config.json and drafts/; run `cc-debrief uninit` to remove the hooks too");
			return true;
		}
		const days = loadConfig().retention.days;
		if (days <= 0) {
			out("retention.days is 0 (keep everything): nothing to purge; `purge --all` deletes everything");
			return true;
		}
		const now = opts.now ?? new Date();
		const c = purgeOlderThan(db, new Date(now.getTime() - days * DAY_MS), { now, dryRun });
		const what = `${count(c.sessions, "session")} older than ${count(days, "day")} (${detail(c)})`;
		if (dryRun) {
			out(`would delete ${what}`);
			return true;
		}
		db.exec("VACUUM");
		out(`deleted ${what}`);
		return true;
	});
}

export function registerPurgeCommand(program: Command): void {
	program
		.command("purge")
		.description("delete data older than retention.days now (--all: every session and event)")
		.option("--all", "delete everything except config.json, drafts/ and the uninit record")
		.option("--yes", "confirm --all without asking")
		.option("--dry-run", "print what would be deleted, delete nothing")
		.action(async (opts: { all?: boolean; yes?: boolean; dryRun?: boolean }) => {
			await runPurge(opts);
		});
}

// cc-debrief dashboard (features 12, 13): scan, pending ingest, then serve the UI on 127.0.0.1 with a live poll;
// a large first backfill, the git enrich of pending sessions and the coaching checks continue in the background.
import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAdaptorServer } from "@hono/node-server";
import { type Command, InvalidArgumentError } from "commander";
import { execa } from "execa";
import type { Hono } from "hono";
import { runDigestRules } from "../coach/digest";
import { logCoachError, runTier1Pending, tier1PendingIds } from "../coach/tier1";
import { loadConfig } from "../config";
import { type Db, openDb } from "../db/adapter";
import { migrate } from "../db/migrate";
import { runRetention } from "../db/queries/retention";
import { cleanupInternalSessions } from "../db/queries/selfUsage";
import { deriveMissingInventoryUsage, scanRepoInto, scanUserInto } from "../derive/inventory-usage";
import { enrichPending } from "../enrich";
import { ingestPendingLocked, pendingGroups } from "../ingest/ingest";
import { checkInstalledPatterns } from "../patterns/adoption";
import { runPatternDetection } from "../patterns/run";
import { createApp } from "../server/app";
import { startRepriceJob, waitForRepriceJob } from "../server/jobs";
import { setBackfillProgress, setTier1Progress } from "../server/progress";
import { ExitCode, type Out, stdout } from "./common";

/** Sessions to ingest before serving; a bigger backlog continues in the background with progress in the UI. */
const FOREGROUND_SESSIONS = 50;
const REPO_SCAN_DAYS = 30;
const ENRICH_BATCH = 200;
const USAGE_BATCH = 50;
const TIER1_DAYS = 30;
const TIER1_BATCH = 50;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const stderr: Out = (line) => void process.stderr.write(`${line}\n`);

/** The UI next to the running cli.js (dist/ui); the bin copy has none. */
export const defaultUiDir = (): string => join(dirname(fileURLToPath(import.meta.url)), "ui");

/** One pending ingest under the session locks (busy sessions skipped); the poll's unit of work. */
export async function pollOnce(db: Db, signal?: AbortSignal): Promise<void> {
	await ingestPendingLocked(db, { signal });
}

/** Runs pollOnce() every `seconds` (0: never), never overlapping itself; returns stop(). */
export function startPoll(db: Db, seconds: number, onError: (e: unknown) => void = () => {}): () => void {
	if (seconds <= 0) return () => {};
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const tick = async () => {
		try {
			await pollOnce(db, controller.signal);
		} catch (e) {
			onError(e);
		}
		if (!controller.signal.aborted) timer = setTimeout(tick, seconds * 1000);
	};
	timer = setTimeout(tick, seconds * 1000);
	return () => {
		controller.abort();
		if (timer) clearTimeout(timer);
	};
}

function openBrowser(url: string): void {
	const [cmd, args] =
		process.platform === "win32"
			? ["cmd", ["/c", "start", '""', url]]
			: process.platform === "darwin"
				? ["open", [url]]
				: ["xdg-open", [url]];
	try {
		execa(cmd, args, { detached: true, stdio: "ignore", windowsHide: true, windowsVerbatimArguments: true }).catch(
			() => {},
		);
	} catch {
		// No browser to open: the printed URL is enough.
	}
}

/**
 * Coaching on `dashboard` start (feature 13; Phase 4 spec decision 1): Tier 1 for the last 30 days' sessions
 * checked with an older TIER1_VERSION (or never), in batches with progress in /api/status, then the digest rules
 * (feature 09). Errors go to coach-errors.log, never to the terminal.
 */
export async function coachInBackground(db: Db, signal: AbortSignal): Promise<void> {
	try {
		const since = new Date(Date.now() - TIER1_DAYS * 86_400_000);
		const total = tier1PendingIds(db, since).length;
		let done = 0;
		if (total > 0) setTier1Progress({ done, total });
		while (!signal.aborted && total > 0) {
			let attempted = 0;
			const n = runTier1Pending(db, {
				since,
				limit: TIER1_BATCH,
				onProgress: (_, batch) => {
					attempted = batch;
				},
			});
			done = Math.min(total, done + n);
			setTier1Progress({ done, total });
			// A session that fails stays pending: stop on a short batch, or one where nothing succeeded (review B7).
			if (attempted < TIER1_BATCH || n === 0) break;
			await new Promise((r) => setImmediate(r));
		}
	} catch (e) {
		logCoachError(e, "tier1");
	} finally {
		setTier1Progress(null);
	}
	if (signal.aborted) return;
	try {
		runDigestRules(db);
	} catch (e) {
		logCoachError(e, "digest");
	}
	if (signal.aborted) return;
	// Repeat patterns for repos active in 30 days, cross-repo, then installed skills (Phase 5b spec decision 8).
	runPatternDetection(db, { signal, afterwards: checkInstalledPatterns });
}

export type DashboardHandle = {
	port: number;
	/** The address the server is bound to (always 127.0.0.1). */
	address: string;
	url: string;
	/** Resolves when the background backfill and enrich are done. */
	idle(): Promise<void>;
	/** Stops the poll and background work, closes the server and the DB. Idempotent. */
	stop(): Promise<void>;
	/** Resolves after stop() (SIGINT / SIGTERM call it). */
	done: Promise<void>;
};

export type DashboardOptions = {
	port?: number; // 0 = any free port (tests)
	open: boolean;
	uiDir?: string;
	out?: Out;
	err?: Out;
	foregroundSessions?: number;
	handleSignals?: boolean;
};

export async function runDashboard(opts: DashboardOptions): Promise<DashboardHandle> {
	const out = opts.out ?? stdout;
	const err = opts.err ?? stderr;
	const uiDir = opts.uiDir ?? defaultUiDir();
	if (!existsSync(join(uiDir, "index.html"))) {
		err(
			"error: this copy of cc-debrief has no dashboard UI. Run `npx cc-debrief dashboard` (the bin copy is for hooks only)",
		);
		throw new ExitCode(1);
	}
	const cfg = loadConfig();
	const wanted = opts.port ?? cfg.dashboard.port;

	const db = openDb();
	const controller = new AbortController();
	let server: ReturnType<typeof createAdaptorServer> | undefined;
	try {
		migrate(db);
		// Leftovers of our own claude -p calls (feature 15), then automatic retention, at most once per 24 h (feature 14).
		cleanupInternalSessions(db);
		runRetention(db, cfg);
		// Inventory first, so sessions derived below join it.
		const scanned = [...scanUserInto(db)];
		const since = new Date(Date.now() - REPO_SCAN_DAYS * 86_400_000).toISOString();
		for (const r of db
			.prepare(
				`SELECT DISTINCT r.repo_id, r.root_path FROM repos r JOIN sessions s ON s.repo_id = r.repo_id
				 WHERE s.started_at >= ?`,
			)
			.all<{ repo_id: string; root_path: string }>(since)) {
			if (existsSync(r.root_path)) scanned.push(...scanRepoInto(db, r.root_path, r.repo_id));
		}

		const backlog = pendingGroups(db).bySession.size;
		const foreground = backlog <= (opts.foregroundSessions ?? FOREGROUND_SESSIONS);
		const ingested = foreground ? await ingestPendingLocked(db) : null;
		const enrichBacklog =
			db.prepare("SELECT count(*) AS n FROM sessions WHERE enriched_at IS NULL").get<{ n: number }>()?.n ?? 0;
		const count = (kind: string) => scanned.filter((i) => i.kind === kind).length;
		const summary = [
			`scan: ${plural(count("skill"), "skill")}, ${plural(count("mcp"), "MCP server")}`,
			ingested
				? `ingest: ${plural(ingested.files, "transcript")}`
				: `ingest: ${plural(backlog, "session")} in the background`,
			`enrich: ${enrichBacklog} pending (no AI)`,
		].join(" · ");

		// The app needs the bound port for its Host check, so it is built once listening.
		let app: Hono | undefined;
		server = createAdaptorServer({
			fetch: (req: Request, env: unknown) => (app as Hono).fetch(req, env),
			hostname: "127.0.0.1",
		});
		const s = server;
		await new Promise<void>((resolve, reject) => {
			s.once("error", reject);
			s.listen(wanted, "127.0.0.1", () => {
				s.off("error", reject);
				resolve();
			});
		}).catch((e: NodeJS.ErrnoException) => {
			err(
				e.code === "EADDRINUSE"
					? `error: port ${wanted} is in use; choose another with --port <n> (or set dashboard.port)`
					: `error: cannot listen on 127.0.0.1:${wanted}: ${e.message}`,
			);
			throw new ExitCode(1);
		});
		const { port, address } = s.address() as AddressInfo;
		app = createApp(db, { port, uiDir });
		const url = `http://127.0.0.1:${port}`;
		const report = (e: unknown) => err(`error: ${e instanceof Error ? e.message : String(e)}`);

		// Shutdown is wired before the URL is printed: a Ctrl+C that lands earlier would otherwise kill the process
		// with the OS default action, skipping the clean close.
		let stopPoll = () => {};
		let background: Promise<void> = Promise.resolve();
		let resolveDone = () => {};
		const done = new Promise<void>((r) => {
			resolveDone = r;
		});
		let stopping: Promise<void> | undefined;
		const onSignal = () => void stop();
		const stop = () => {
			stopping ??= (async () => {
				process.off("SIGINT", onSignal);
				process.off("SIGTERM", onSignal);
				stopPoll();
				controller.abort();
				await background;
				await new Promise<void>((r) => s.close(() => r()));
				db.close();
				resolveDone();
			})();
			return stopping;
		};
		if (opts.handleSignals ?? true) {
			process.once("SIGINT", onSignal);
			process.once("SIGTERM", onSignal);
		}

		out(summary);
		out(`cc-debrief dashboard on ${url}  (Ctrl+C to stop)`);
		if (opts.open) openBrowser(url);

		background = (async () => {
			try {
				if (!foreground) {
					setBackfillProgress({ done: 0, total: backlog });
					await ingestPendingLocked(db, {
						signal: controller.signal,
						onProgress: (done, total) => setBackfillProgress({ done, total }),
					});
				}
			} catch (e) {
				report(e);
			} finally {
				setBackfillProgress(null);
			}
			try {
				// Sessions derived before Phase 2: inventory usage in small batches, yielding so requests are served.
				while (!controller.signal.aborted && deriveMissingInventoryUsage(db, USAGE_BATCH) === USAGE_BATCH) {
					await new Promise((r) => setImmediate(r));
				}
			} catch (e) {
				report(e);
			}
			try {
				while (!controller.signal.aborted) {
					const n = await enrichPending(db, { ai: false, limit: ENRICH_BATCH, signal: controller.signal });
					if (n < ENRICH_BATCH) break;
				}
			} catch (e) {
				report(e);
			}
			// Sessions priced with an older table (a pricing override changed while the dashboard was off, Phase 7 P7).
			startRepriceJob(db, controller.signal);
			await waitForRepriceJob();
			await coachInBackground(db, controller.signal);
		})();
		stopPoll = startPoll(db, cfg.dashboard.pollSeconds, report);
		return { port, address, url, idle: () => background, stop, done };
	} catch (e) {
		controller.abort();
		if (server?.listening) server.close();
		db.close();
		throw e;
	}
}

function parsePort(value: string): number {
	const n = Number(value);
	if (!Number.isInteger(n) || n < 0 || n > 65_535) throw new InvalidArgumentError("not a port number (0-65535)");
	return n;
}

export function registerDashboardCommand(program: Command): void {
	program
		.command("dashboard")
		.description("open the local dashboard (scans, imports pending transcripts, then serves on 127.0.0.1)")
		.option("--port <n>", "port to listen on (default: dashboard.port, 4242)", parsePort)
		.option("--no-open", "do not open a browser")
		.action(async (opts: { port?: number; open: boolean }) => {
			const d = await runDashboard({ port: opts.port, open: opts.open });
			await d.done;
		});
}

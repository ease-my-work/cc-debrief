// Hook routing and the per-event work. This module imports nothing heavy at load time: the spawn happens before
// zod, the config schema or node:sqlite are loaded (dynamic imports below, after the spawn).
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "../db/adapter";
import { ensureDir, rawDir } from "../paths";
import { logHookError } from "./errors";

export type Route = { spawn: string[] | null; insert: boolean };
const NOTHING: Route = { spawn: null, insert: false };
// Session ids reach worker argv and lock file names.
export const SESSION_ID = /^[A-Za-z0-9-]{1,100}$/;

/**
 * `--expect` for the Stop worker: first 16 hex chars of SHA-256 over the first 200 characters of the reply with
 * whitespace collapsed (architecture hook rule 10). The reply itself never reaches a command line.
 */
export function expectHash(text: string): string {
	const norm = text.replace(/\s+/g, " ").trim().slice(0, 200);
	return createHash("sha256").update(norm).digest("hex").slice(0, 16);
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** What the hook does for a payload: which worker to spawn (cli.js argv) and whether to insert an events row. */
export function routeHook(payload: unknown, env: NodeJS.ProcessEnv): Route {
	if (env.CC_DEBRIEF_INTERNAL === "1" || !isObj(payload)) return NOTHING;
	const id = payload.session_id;
	if (typeof id !== "string" || !SESSION_ID.test(id)) return NOTHING;
	switch (payload.hook_event_name) {
		case "SessionStart": {
			const cwd = typeof payload.cwd === "string" && payload.cwd ? ["--cwd", payload.cwd] : [];
			return { spawn: ["snapshot", id, ...cwd, "--from-hook"], insert: true };
		}
		case "Stop": {
			const reply = payload.last_assistant_message;
			const expect = typeof reply === "string" && reply.trim() ? ["--expect", expectHash(reply)] : [];
			return { spawn: ["ingest", id, "--from-hook", ...expect], insert: false };
		}
		case "PermissionRequest":
			return { spawn: null, insert: true };
		case "SessionEnd":
			return { spawn: ["enrich", id, "--from-hook"], insert: true };
		default:
			return NOTHING;
	}
}

/** Starts `node <dir of this file>/cli.js ...args` detached, so it outlives the hook. */
export function spawnWorker(cliArgs: string[]): void {
	const cli = join(dirname(fileURLToPath(import.meta.url)), "cli.js");
	const child = spawn(process.execPath, [cli, ...cliArgs], { detached: true, stdio: "ignore", windowsHide: true });
	child.on("error", (e) => logHookError(e, cliArgs[0]));
	child.unref();
}

export type HookDeps = { spawn?: (cliArgs: string[]) => void; now?: () => Date };

/**
 * One hook invocation: parse, route, spawn first, then (SessionStart / PermissionRequest / SessionEnd) insert one
 * redacted events row. Never throws; errors go to hook-errors.log.
 */
export async function runHook(stdin: string, env: NodeJS.ProcessEnv, db?: Db, deps: HookDeps = {}): Promise<void> {
	const receivedAt = (deps.now ?? (() => new Date()))().toISOString();
	let event: string | undefined;
	try {
		if (env.CC_DEBRIEF_RAW_DUMP === "1") {
			ensureDir(rawDir());
			writeFileSync(join(rawDir(), `${receivedAt.replace(/[:.]/g, "-")}-${process.pid}.json`), stdin, { mode: 0o600 });
		}
		let payload: unknown;
		try {
			payload = JSON.parse(stdin);
		} catch {
			logHookError(new Error("stdin is not valid JSON"));
			return;
		}
		if (isObj(payload) && typeof payload.hook_event_name === "string") event = payload.hook_event_name;
		const route = routeHook(payload, env);
		if (!route.spawn && !route.insert) {
			if (env.CC_DEBRIEF_INTERNAL !== "1")
				logHookError(new Error("payload without a usable session_id or event"), event);
			return;
		}
		if (route.spawn) (deps.spawn ?? spawnWorker)(route.spawn);
		if (!route.insert) return;

		// Only now: capture config, redaction and SQLite. No zod in the hook (bundle size is start-up time); routeHook
		// has already checked session_id and hook_event_name, and every other field passes through (HookPayload).
		const { loadCaptureConfig } = await import("../capture-config");
		const capture = loadCaptureConfig();
		if (event === "PermissionRequest" && !capture.permissionHook) return;
		const { redactDeep } = await import("../redact");
		const clean = redactDeep(
			payload as { session_id: string; hook_event_name: string },
			capture.redact,
			capture.maxFieldBytes,
		);
		let conn = db;
		if (!conn) {
			const { openDb } = await import("../db/adapter");
			const { migrate } = await import("../db/migrate");
			conn = openDb();
			migrate(conn);
		}
		try {
			conn
				.prepare("INSERT INTO events (session_id, event, ts, payload) VALUES (?, ?, ?, ?)")
				.run(clean.session_id, clean.hook_event_name, receivedAt, JSON.stringify(clean));
		} finally {
			if (!db) conn.close();
		}
	} catch (e) {
		logHookError(e, event);
	}
}

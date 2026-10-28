// cc-debrief doctor (feature 13): gatherProbes() reads the machine, runChecks() turns the readings into
// PASS / WARN / FAIL lines without side effects (the two slow probes are functions it calls only when needed).
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { HOOK_ENTRY_OPTIONS, HOOK_MARKER, hookCommand, readSettingsBytes, SUBSCRIBED_EVENTS } from "../claude/settings";
import { formatBytes, projectsSize } from "../collector/storage";
import { pendingSummaryIds } from "../collector/summarize";
import { type ConfigIssue, configErrors, loadConfig, unknownConfigKeys } from "../config";
import { type Db, openDb } from "../db/adapter";
import { migrate } from "../db/migrate";
import { getMeta, setMeta } from "../db/queries/meta";
import { listTranscripts } from "../ingest/files";
import { binDir, claudeSettingsPath, configPath, dataDir, dbPath, hookErrorsLogPath } from "../paths";
import { compilePattern, expandPatterns } from "../redact";
import { VERSION } from "../version";
import { count, ExitCode, type Out, stdout, tilde } from "./common";

const num = (n: number) => n.toLocaleString("en-US");

// Every line and attachment type seen in the Phase 0 survey (findings A9) and fixtures; others are reported.
export const KNOWN_LINE_TYPES = new Set([
	"user",
	"assistant",
	"system",
	"attachment",
	"summary",
	"progress",
	"custom-title",
	"agent-name",
	"ai-title",
	"cost-state",
	"file-history-snapshot",
	"file-history-delta",
	"atis-latch",
	"queue-operation",
	"last-prompt",
	"bridge-session",
	"pr-link",
	"relocated",
	"mode",
	"permission-mode",
	"frame-link",
	"artifact-autoreact-ledger",
	"artifact-comment-monitor",
]);
export const KNOWN_ATTACHMENT_TYPES = new Set([
	"agent_listing_delta",
	"async_hook_response",
	"auto_mode",
	"auto_mode_exit",
	"command_permissions",
	"credential_org",
	"date",
	"deferred_tools_delta",
	"deferred_tools_record",
	"dynamic_skill",
	"edited_text_file",
	"environment",
	"file",
	"hook_additional_context",
	"hook_success",
	"instructions",
	"invoked_skills",
	"mcp_instructions_delta",
	"model",
	"plan_mode_exit",
	"prompt_snapshot",
	"remote_session_change",
	"session_context",
	"silent_turn_reminder",
	"skill_listing",
	"task_reminder",
	"todo_reminder",
	"total_tokens_reminder",
]);

const MIN_NODE = "22.13.0";
const HOOK_SLOW_MS = 150; // Phase 0 B3: p95 109 ms Windows, 56 ms Linux
const PATTERN_SLOW_MS = 5;
const PARSE_WARN = 0.01;
const PARSE_FAIL = 0.1;
const HOUR = 3_600_000;
const SUMMARY_BACKLOG = 20;
const DAY = 86_400_000;
const DOCTOR_SESSION = "00000000-0000-4000-8000-00000000d0c7";

export type Check = { id: string; status: "PASS" | "WARN" | "FAIL"; message: string };
export type HookEntry = { event: string; command: string; async?: unknown; timeout?: unknown };
export type Probes = {
	now: Date;
	nodeVersion: string;
	claudeVersion: () => { found: boolean; version: string | null };
	internalEnv: boolean;
	packageVersion: string;
	permissionHook: boolean;
	retentionDays: number;
	/** entries: the tracker's hook entries only (command carries the marker). */
	settings: { path: string; error: string | null; entries: HookEntry[]; cleanupPeriodDays: number | null };
	expectedCommand: string;
	bin: { hookJs: boolean; cliJs: boolean; version: string | null };
	hookRunMs: () => number | null;
	db: { ok: true; path: string; bytes: number } | { ok: false; path: string; error: string };
	/** Phase 7 P11: size of ~/.claude/projects (Claude Code's transcripts); null when not measured. */
	projects?: { bytes: number; cut: boolean } | null;
	/** redact: each expanded pattern with its time on a 32 KB sample; ms null = does not compile. */
	config: { errors: ConfigIssue[]; unknownKeys: string[]; redact: { pattern: string; ms: number | null }[] };
	/** Over the last 20 sessions that have transcript rows. */
	parse: { sessions: number; lines: number; errors: number; unknownTypes: { type: string; version: string | null }[] };
	transcripts: { onDisk: number; backlog: number; changedLast7d: boolean; lastIngestAt: string | null };
	lastHookEventAt: string | null;
	hookErrors24h: number;
	/** null = not applicable (Windows). */
	fileModes: { path: string; mode: number; want: number }[] | null;
	pendingEnrich: number;
	summariesEnabled: boolean;
	/** Pending hook-captured summaries; failures whose last attempt was in 7 days, with the most common reason; the
	 * pinned model when the last failed summary call's error names a model. */
	summaries: { pending: number; errors7d: number; topError: string | null; modelRejected: string | null };
};

function semverLess(a: string, b: string): boolean {
	const pa = a.split(".").map((x) => Number.parseInt(x, 10) || 0);
	const pb = b.split(".").map((x) => Number.parseInt(x, 10) || 0);
	for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0);
	return false;
}

function since(iso: string, now: Date): string {
	const ms = now.getTime() - Date.parse(iso);
	if (ms < HOUR) return `${Math.max(0, Math.round(ms / 60_000))} min ago`;
	if (ms < DAY) return `${Math.round(ms / HOUR)} h ago`;
	return `${Math.round(ms / DAY)} days ago`;
}

const octal = (m: number) => `0${m.toString(8)}`;

function hookChecks(p: Probes): { checks: Check[]; installed: boolean } {
	const s = p.settings;
	if (s.error)
		return { checks: [{ id: "hooks", status: "FAIL", message: `${tilde(s.path)}: ${s.error}` }], installed: false };
	const installed = s.entries.length > 0 || p.bin.hookJs || p.bin.cliJs;
	if (!installed) {
		const message =
			"hooks not installed (read-only mode): run `cc-debrief init` for git start state and permission prompts";
		return { checks: [{ id: "hooks", status: "WARN", message }], installed };
	}
	const expected: string[] = SUBSCRIBED_EVENTS.filter((e) => e !== "PermissionRequest" || p.permissionHook);
	const fails: string[] = [];
	const warns: string[] = [];
	const missing = expected.filter((e) => !s.entries.some((x) => x.event === e));
	if (missing.length > 0) fails.push(`missing ${missing.join(", ")}`);
	const stop = s.entries.find((x) => x.event === "Stop");
	if (stop && stop.async !== true) fails.push("the Stop entry lacks async: true");
	if (!p.bin.hookJs) fails.push(`${tilde(join(binDir(), "hook.js"))} missing`);
	if (!p.bin.cliJs) fails.push(`${tilde(join(binDir(), "cli.js"))} missing`);

	const stale = [...new Set(s.entries.filter((x) => !expected.includes(x.event)).map((x) => x.event))];
	if (stale.length > 0) warns.push(`tracker entries under events it does not use: ${stale.join(", ")}`);
	if (s.entries.some((x) => x.command !== p.expectedCommand)) warns.push("an entry runs another hook.js than bin/");
	const end = s.entries.find((x) => x.event === "SessionEnd");
	if (end && end.timeout !== HOOK_ENTRY_OPTIONS.SessionEnd.timeout)
		warns.push("the SessionEnd entry lacks timeout: 3600");
	if (p.bin.version === null || semverLess(p.bin.version, p.packageVersion)) {
		warns.push(`bin/ copy is v${p.bin.version ?? "?"}, older than this package (v${p.packageVersion})`);
	}
	const fix = " (run `cc-debrief init`)";
	if (fails.length > 0) {
		return {
			checks: [{ id: "hooks", status: "FAIL", message: `hooks: ${[...fails, ...warns].join("; ")}${fix}` }],
			installed,
		};
	}
	if (warns.length > 0)
		return { checks: [{ id: "hooks", status: "WARN", message: `hooks: ${warns.join("; ")}${fix}` }], installed };
	const n = expected.length;
	return {
		checks: [{ id: "hooks", status: "PASS", message: `${n}/${n} hook entries in ${tilde(s.path)}` }],
		installed,
	};
}

/** The checks for one set of readings (feature 13 doctor table), in display order. */
export function runChecks(p: Probes): Check[] {
	const checks: Check[] = [];
	const add = (id: string, status: Check["status"], message: string) => checks.push({ id, status, message });

	add("node", semverLess(p.nodeVersion, MIN_NODE) ? "FAIL" : "PASS", `Node ${p.nodeVersion} (>= 22.13)`);

	const claude = p.claudeVersion();
	// Summaries run claude -p; with them off, a desktop-only user may have no claude on PATH.
	if (!claude.found && p.summariesEnabled) {
		add(
			"claude",
			"FAIL",
			"claude not found on PATH: AI summaries cannot run (install Claude Code, or: cc-debrief config set ai.summaries.enabled false)",
		);
	} else if (!claude.found) add("claude", "WARN", "claude not found on PATH (fine while AI summaries are off)");
	else if (!claude.version) add("claude", "WARN", "claude on PATH, but its version could not be read");
	else add("claude", "PASS", `claude ${claude.version} on PATH`);

	const hooks = hookChecks(p);
	checks.push(...hooks.checks);
	if (hooks.installed && p.bin.hookJs && !p.settings.error) {
		const ms = p.hookRunMs();
		if (ms === null) add("hook-time", "WARN", "could not time a hook run");
		else if (ms > HOOK_SLOW_MS) {
			const hint = p.permissionHook
				? "; if that is typical, fewer hook runs: cc-debrief config set capture.permissionHook false"
				: "";
			add("hook-time", "WARN", `hook run took ${Math.round(ms)} ms, Node start included (> ${HOOK_SLOW_MS} ms)${hint}`);
		} else add("hook-time", "PASS", `hook run ${Math.round(ms)} ms, Node start included`);
	}

	if (p.db.ok) add("db", "PASS", `DB writable (${tilde(p.db.path)}, ${(p.db.bytes / 1024 / 1024).toFixed(1)} MB)`);
	else add("db", "FAIL", `DB not writable (${tilde(p.db.path)}): ${p.db.error}`);
	if (p.projects)
		add(
			"projects",
			"PASS",
			`Claude Code transcripts (~/.claude/projects): ${formatBytes(p.projects)}${p.projects.cut ? " (stopped after 2 s)" : ""}`,
		);

	const c = p.config;
	if (c.errors.length > 0) {
		add(
			"config",
			"FAIL",
			`config invalid (defaults used for these): ${c.errors.map((e) => `${e.key}: ${e.message}`).join("; ")}`,
		);
	} else {
		const w: string[] = [];
		if (c.unknownKeys.length > 0) w.push(`unknown keys ${c.unknownKeys.join(", ")} (ignored)`);
		for (const r of c.redact) {
			if (r.ms === null) w.push(`redact pattern ${JSON.stringify(r.pattern)} does not compile (skipped)`);
			else if (r.ms > PATTERN_SLOW_MS)
				w.push(
					`redact pattern ${JSON.stringify(r.pattern)} takes ${r.ms.toFixed(1)} ms on 32 KB (> ${PATTERN_SLOW_MS} ms)`,
				);
		}
		if (w.length > 0) add("config", "WARN", `config: ${w.join("; ")}`);
		else add("config", "PASS", "config valid");
	}

	if (p.db.ok) {
		const q = p.parse;
		if (q.sessions === 0) add("parse", "PASS", "no transcripts ingested yet");
		else {
			const rate = q.lines > 0 ? q.errors / q.lines : 0;
			let message = `transcript parse failures ${(rate * 100).toFixed(1)}% (${q.errors.toLocaleString("en-US")} of ${count(q.lines, "line")}, last ${count(q.sessions, "session")})`;
			if (q.unknownTypes.length > 0) {
				const list = q.unknownTypes.map((u) => `"${u.type}"${u.version ? ` (Claude Code ${u.version})` : ""}`);
				message += `; new line type${q.unknownTypes.length === 1 ? "" : "s"} ${list.join(", ")}`;
			}
			add(
				"parse",
				rate > PARSE_FAIL ? "FAIL" : rate > PARSE_WARN || q.unknownTypes.length > 0 ? "WARN" : "PASS",
				message,
			);
		}

		const t = p.transcripts;
		if (t.backlog > 0) {
			add(
				"backlog",
				"WARN",
				`${count(t.backlog, "transcript")} changed over 1 h ago but not ingested: run \`cc-debrief ingest\``,
			);
		} else add("backlog", "PASS", `ingest up to date (${count(t.onDisk, "transcript")} on disk)`);

		if (t.onDisk === 0 && !t.lastIngestAt) add("last-ingest", "PASS", "no transcripts yet");
		else if (!t.lastIngestAt)
			add("last-ingest", "WARN", "transcripts on disk were never ingested: run `cc-debrief ingest`");
		else if (p.now.getTime() - Date.parse(t.lastIngestAt) > 7 * DAY) {
			add("last-ingest", "WARN", `last ingest ${since(t.lastIngestAt, p.now)}`);
		} else add("last-ingest", "PASS", `last ingest ${since(t.lastIngestAt, p.now)}`);

		if (hooks.installed) {
			const last = p.lastHookEventAt;
			const quiet = !last || p.now.getTime() - Date.parse(last) > 7 * DAY;
			if (quiet && t.changedLast7d) {
				add(
					"last-hook-event",
					"WARN",
					`no hook event in 7 days while transcripts changed: the hook is not firing (last ${last ? since(last, p.now) : "never"})`,
				);
			} else add("last-hook-event", "PASS", last ? `last hook event ${since(last, p.now)}` : "no hook event yet");
		}
	}

	const cleanup = p.settings.cleanupPeriodDays;
	if (cleanup !== null && (p.retentionDays === 0 || cleanup < p.retentionDays)) {
		add(
			"cleanup",
			"WARN",
			`cleanupPeriodDays ${cleanup} in settings.json is shorter than retention.days ${p.retentionDays || "(forever)"}: Claude Code may delete transcripts first (harmless while ingest keeps up)`,
		);
	} else
		add(
			"cleanup",
			"PASS",
			cleanup === null
				? "cleanupPeriodDays not set"
				: `cleanupPeriodDays ${cleanup} >= retention.days ${p.retentionDays}`,
		);

	if (p.hookErrors24h > 0) {
		add(
			"hook-errors",
			"WARN",
			`${count(p.hookErrors24h, "hook error")} in the last 24 h (see ${tilde(hookErrorsLogPath())})`,
		);
	} else add("hook-errors", "PASS", "no hook errors in the last 24 h");

	if (p.fileModes === null) add("file-modes", "PASS", "file permissions: not applicable on Windows");
	else if (p.fileModes.length > 0) {
		add(
			"file-modes",
			"WARN",
			`file permissions: ${p.fileModes.map((m) => `${tilde(m.path)} is ${octal(m.mode)}, want ${octal(m.want)}`).join("; ")}`,
		);
	} else add("file-modes", "PASS", "file permissions 0700 / 0600");

	const s = p.summaries;
	if (!p.summariesEnabled) add("summaries", "PASS", "AI summaries off");
	else if (s.errors7d > 0) {
		add(
			"summaries",
			"WARN",
			`${count(s.errors7d, "summary failure")} in 7 days (most common: ${s.topError ?? "unknown"}); see summary_error in the session`,
		);
	} else if (s.pending > SUMMARY_BACKLOG) {
		add(
			"summaries",
			"WARN",
			`${num(s.pending)} summaries pending: run \`cc-debrief enrich\` (daily cap or failed spawns)`,
		);
	} else add("summaries", "PASS", s.pending > 0 ? `${num(s.pending)} summaries pending` : "summaries up to date");
	if (s.modelRejected) add("model", "WARN", `ai.model was rejected by the last summary call: ${s.modelRejected}`);

	if (p.pendingEnrich > 0) {
		add("pending", "WARN", `${count(p.pendingEnrich, "session")} not enriched for over 1 h: run \`cc-debrief enrich\``);
	} else add("pending", "PASS", "no pending enrichment");

	if (p.internalEnv) {
		add(
			"internal-env",
			"WARN",
			"CC_DEBRIEF_INTERNAL is set in this shell: Claude Code sessions started from it are not recorded",
		);
	}
	return checks;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function readSettings(): Probes["settings"] {
	const path = claudeSettingsPath();
	const out: Probes["settings"] = { path, error: null, entries: [], cleanupPeriodDays: null };
	let bytes: Buffer | null;
	try {
		bytes = readSettingsBytes(path);
	} catch (e) {
		return { ...out, error: (e as Error).message };
	}
	if (!bytes) return out;
	let value: unknown;
	try {
		value = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, ""));
	} catch {
		return { ...out, error: "not valid JSON" };
	}
	if (!isObj(value)) return { ...out, error: "does not hold a JSON object" };
	if (typeof value.cleanupPeriodDays === "number") out.cleanupPeriodDays = value.cleanupPeriodDays;
	if (isObj(value.hooks)) {
		for (const [event, groups] of Object.entries(value.hooks)) {
			if (!Array.isArray(groups)) continue;
			for (const g of groups) {
				if (!isObj(g) || !Array.isArray(g.hooks)) continue;
				for (const h of g.hooks) {
					if (isObj(h) && typeof h.command === "string" && h.command.includes(HOOK_MARKER)) {
						out.entries.push({ event, command: h.command, async: h.async, timeout: h.timeout });
					}
				}
			}
		}
	}
	return out;
}

// A 32 KB sample shaped like transcript text: prose, paths, code, and a few key-like strings.
function redactSample(): string {
	const chunk =
		"Updated src/server/app.ts and ran npm test: 42 passed. const token = process.env.API_TOKEN ?? '';\n" +
		"curl -H 'Authorization: Bearer abcdefghijklmnop' https://api.example.com/v1/items?id=12345 && echo ok\n" +
		"C:\\Users\\dev\\project\\README.md line 7: the quick brown fox jumps over the lazy dog 0123456789.\n";
	return chunk.repeat(Math.ceil(32768 / chunk.length)).slice(0, 32768);
}

const PATTERN_RUNS = 3;

/**
 * Each pattern's time on the sample: one warm-up run, then the fastest of PATTERN_RUNS. A single timed run read a GC
 * pause or a busy machine as a slow pattern (default patterns take 1-2 ms against the 5 ms limit); a backtracking
 * pattern is slow on every run, so the fastest still flags it.
 */
export function timePatterns(
	list: string[],
	clock: () => number = () => performance.now(),
): { pattern: string; ms: number | null }[] {
	const sample = redactSample();
	return expandPatterns(list).map((pattern) => {
		const re = compilePattern(pattern);
		if (!re) return { pattern, ms: null };
		sample.replace(re, "[REDACTED]");
		let best = Number.POSITIVE_INFINITY;
		for (let i = 0; i < PATTERN_RUNS; i++) {
			const t = clock();
			sample.replace(re, "[REDACTED]");
			best = Math.min(best, clock() - t);
		}
		return { pattern, ms: best };
	});
}

// The last "timestamp" in the file's final 256 KB (where ingest's cutoff looks), or null.
function lastTimestamp(path: string): string | null {
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		const size = fstatSync(fd).size;
		const len = Math.min(size, 256 * 1024);
		const buf = Buffer.alloc(len);
		readSync(fd, buf, 0, len, size - len);
		const text = buf.toString("utf8");
		const i = text.lastIndexOf('"timestamp":"');
		if (i === -1) return null;
		const from = i + '"timestamp":"'.length;
		const to = text.indexOf('"', from);
		return to === -1 ? null : text.slice(from, to);
	} catch {
		return null;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function countRecentErrors(now: Date): number {
	let n = 0;
	for (const path of [hookErrorsLogPath(), `${hookErrorsLogPath()}.1`]) {
		let text: string;
		try {
			text = readFileSync(path, "utf8");
		} catch {
			continue;
		}
		for (const line of text.split("\n")) {
			const ts = Date.parse(line.slice(0, line.indexOf("\t")));
			if (!Number.isNaN(ts) && now.getTime() - ts <= DAY) n++;
		}
	}
	return n;
}

function fileModes(): Probes["fileModes"] {
	if (process.platform === "win32") return null;
	const out: { path: string; mode: number; want: number }[] = [];
	for (const [path, want] of [
		[dataDir(), 0o700],
		[dbPath(), 0o600],
		[configPath(), 0o600],
	] as const) {
		try {
			const mode = statSync(path).mode & 0o777;
			if (mode & ~want) out.push({ path, mode, want });
		} catch {
			// not created yet
		}
	}
	return out;
}

function claudeVersion(env: NodeJS.ProcessEnv): { found: boolean; version: string | null } {
	// Claude Code on Windows is a .cmd or .exe found through PATH / PATHEXT, which needs a shell.
	const r = spawnSync("claude", ["--version"], {
		env,
		encoding: "utf8",
		timeout: 10_000,
		windowsHide: true,
		shell: process.platform === "win32",
	});
	if (r.error || r.status !== 0) return { found: false, version: null };
	return { found: true, version: /\d+\.\d+\.\d+\S*/.exec(r.stdout ?? "")?.[0] ?? null };
}

function timeHookRun(env: NodeJS.ProcessEnv): number | null {
	const payload = JSON.stringify({
		session_id: DOCTOR_SESSION,
		hook_event_name: "Stop",
		cwd: process.cwd(),
		stop_hook_active: false,
		last_assistant_message: "doctor timing run",
	});
	const t = performance.now();
	// Internal mode: the hook starts, reads and routes the payload, then does nothing, so doctor has no side effects.
	const r = spawnSync(process.execPath, [join(binDir(), "hook.js")], {
		env: { ...env, CC_DEBRIEF_INTERNAL: "1" },
		input: payload,
		timeout: 10_000,
		windowsHide: true,
	});
	const ms = performance.now() - t;
	return r.error || r.status !== 0 ? null : ms;
}

/** Reads everything runChecks needs. Opens (and migrates) the DB; never writes outside a rolled-back test write. */
export async function gatherProbes(opts: { env?: NodeJS.ProcessEnv } = {}): Promise<Probes> {
	const env = opts.env ?? process.env;
	const now = new Date();
	const config = loadConfig();
	const binVersion = (() => {
		try {
			return readFileSync(join(binDir(), "version"), "utf8").trim() || null;
		} catch {
			return null;
		}
	})();
	const probes: Probes = {
		now,
		nodeVersion: process.versions.node,
		claudeVersion: () => claudeVersion(env),
		internalEnv: env.CC_DEBRIEF_INTERNAL === "1",
		packageVersion: VERSION,
		permissionHook: config.capture.permissionHook,
		retentionDays: config.retention.days,
		settings: readSettings(),
		expectedCommand: hookCommand(join(binDir(), "hook.js")),
		bin: {
			hookJs: existsSync(join(binDir(), "hook.js")),
			cliJs: existsSync(join(binDir(), "cli.js")),
			version: binVersion,
		},
		hookRunMs: () => timeHookRun(env),
		db: { ok: false, path: dbPath(), error: "not checked" },
		projects: projectsSize({ fresh: true }),
		config: { errors: configErrors(), unknownKeys: unknownConfigKeys(), redact: timePatterns(config.capture.redact) },
		parse: { sessions: 0, lines: 0, errors: 0, unknownTypes: [] },
		transcripts: { onDisk: 0, backlog: 0, changedLast7d: false, lastIngestAt: null },
		lastHookEventAt: null,
		hookErrors24h: countRecentErrors(now),
		fileModes: fileModes(),
		pendingEnrich: 0,
		summariesEnabled: config.ai.summaries.enabled,
		summaries: { pending: 0, errors7d: 0, topError: null, modelRejected: null },
	};

	let db: ReturnType<typeof openDb> | undefined;
	try {
		db = openDb();
		migrate(db);
		const ROLLBACK = new Error("rollback");
		try {
			db.transaction(() => {
				setMeta(db as NonNullable<typeof db>, "doctor.write_test", now.toISOString());
				throw ROLLBACK;
			});
		} catch (e) {
			if (e !== ROLLBACK) throw e;
		}
		let bytes = 0;
		for (const f of [dbPath(), `${dbPath()}-wal`]) {
			try {
				bytes += statSync(f).size;
			} catch {
				// no WAL file
			}
		}
		probes.db = { ok: true, path: dbPath(), bytes };
	} catch (e) {
		probes.db = { ok: false, path: dbPath(), error: (e as Error).message };
		db?.close();
		return probes;
	}

	try {
		// Last 20 sessions with transcript rows: snapshot-only sessions (no transcript yet) never count.
		const recent = db
			.prepare(
				`SELECT s.session_id AS id, s.cc_version AS version FROM sessions s
				 WHERE EXISTS (SELECT 1 FROM transcripts t WHERE t.session_id = s.session_id AND t.internal = 0)
				 ORDER BY coalesce(s.started_at, '') DESC LIMIT 20`,
			)
			.all<{ id: string; version: string | null }>();
		if (recent.length > 0) {
			const marks = recent.map(() => "?").join(",");
			const ids = recent.map((r) => r.id);
			const sums = db
				.prepare(
					`SELECT coalesce(sum(lines), 0) AS lines, coalesce(sum(parse_errors), 0) AS errors FROM transcripts
					 WHERE internal = 0 AND session_id IN (${marks})`,
				)
				.get<{ lines: number; errors: number }>(...ids);
			const version = new Map(recent.map((r) => [r.id, r.version]));
			const unknown = new Map<string, string | null>();
			for (const r of db
				.prepare(
					`SELECT type, subtype, min(session_id) AS id FROM transcript_lines WHERE session_id IN (${marks})
					 GROUP BY type, CASE WHEN type = 'attachment' THEN subtype END ORDER BY min(id)`,
				)
				.all<{ type: string; subtype: string | null; id: string }>(...ids)) {
				const name = !KNOWN_LINE_TYPES.has(r.type)
					? r.type
					: r.type === "attachment" && r.subtype && !KNOWN_ATTACHMENT_TYPES.has(r.subtype)
						? `attachment:${r.subtype}`
						: null;
				if (name && !unknown.has(name)) unknown.set(name, version.get(r.id) ?? null);
			}
			probes.parse = {
				sessions: recent.length,
				lines: sums?.lines ?? 0,
				errors: sums?.errors ?? 0,
				unknownTypes: [...unknown].map(([type, v]) => ({ type, version: v })),
			};
		}

		const rows = new Map(
			db
				.prepare("SELECT path, size, mtime_ms, internal, purged_at FROM transcripts")
				.all<{ path: string; size: number; mtime_ms: number; internal: number; purged_at: string | null }>()
				.map((r) => [r.path, r]),
		);
		const notBefore = getMeta(db, "ingest_not_before");
		const floor = Math.max(
			config.retention.days > 0 ? now.getTime() - config.retention.days * DAY : 0,
			notBefore ? Date.parse(notBefore) : 0,
		);
		const files = listTranscripts();
		let backlog = 0;
		for (const f of files) {
			const r = rows.get(f.path);
			if (r && (r.internal || r.purged_at || (r.size === f.size && r.mtime_ms === f.mtimeMs))) continue;
			if (f.mtimeMs >= now.getTime() - HOUR || f.mtimeMs < floor) continue;
			// A file never read whose last line is older than the retention window is skipped by ingest (backfill
			// cutoff), however recently the file was touched: no backlog.
			const last = r ? null : lastTimestamp(f.path);
			if (
				last !== null &&
				config.retention.days > 0 &&
				Date.parse(last) < now.getTime() - config.retention.days * DAY
			) {
				continue;
			}
			backlog++;
		}
		probes.transcripts = {
			onDisk: files.length,
			backlog,
			changedLast7d: files.some((f) => f.mtimeMs >= now.getTime() - 7 * DAY),
			lastIngestAt:
				db.prepare("SELECT max(last_ingested_at) AS t FROM transcripts").get<{ t: string | null }>()?.t ?? null,
		};
		probes.lastHookEventAt = db.prepare("SELECT max(ts) AS t FROM events").get<{ t: string | null }>()?.t ?? null;
		probes.pendingEnrich =
			db
				.prepare("SELECT count(*) AS n FROM sessions WHERE enriched_at IS NULL AND coalesce(ended_at, started_at) < ?")
				.get<{ n: number }>(new Date(now.getTime() - HOUR).toISOString())?.n ?? 0;
		probes.summaries = summaryProbe(db, config.ai.model, now);
	} finally {
		db.close();
	}
	return probes;
}

function summaryProbe(db: Db, model: string | undefined, now: Date): Probes["summaries"] {
	const week = new Date(now.getTime() - 7 * DAY).toISOString();
	// A session's last attempt time comes from ai_calls (summary_error has no time of its own).
	const errors = db
		.prepare(
			`SELECT s.summary_error AS e FROM sessions s
			 WHERE s.summary_error IS NOT NULL
			   AND (SELECT max(a.ts) FROM ai_calls a WHERE a.feature = 'summary' AND a.target_session_id = s.session_id) >= ?`,
		)
		.all<{ e: string }>(week);
	const reasons = new Map<string, number>();
	for (const { e } of errors) {
		const reason = e.split(": ")[0];
		reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
	}
	const topError = [...reasons.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
	let modelRejected: string | null = null;
	if (model) {
		const last = db
			.prepare(
				`SELECT s.summary_error AS e FROM ai_calls a JOIN sessions s ON s.session_id = a.target_session_id
				 WHERE a.feature = 'summary' ORDER BY a.ts DESC, a.id DESC LIMIT 1`,
			)
			.get<{ e: string | null }>();
		if (last?.e && /model/i.test(last.e)) modelRejected = `${model}: ${last.e}`;
	}
	return {
		pending: pendingSummaryIds(db, { capture: "hooks", now }).length,
		errors7d: errors.length,
		topError,
		modelRejected,
	};
}

/** Prints one line per check and the totals; returns 1 when any check failed. */
export async function runDoctor(
	opts: { out?: Out; env?: NodeJS.ProcessEnv; hookRunMs?: () => number | null } = {},
): Promise<number> {
	const out = opts.out ?? stdout;
	const probes = await gatherProbes({ env: opts.env });
	if (opts.hookRunMs) probes.hookRunMs = opts.hookRunMs;
	const checks = runChecks(probes);
	for (const c of checks) out(`${c.status.padEnd(4)}  ${c.message}`);
	const warnings = checks.filter((c) => c.status === "WARN").length;
	const failures = checks.filter((c) => c.status === "FAIL").length;
	out(`${count(warnings, "warning")}, ${count(failures, "failure")}`);
	return failures > 0 ? 1 : 0;
}

export function registerDoctorCommand(program: Command): void {
	program
		.command("doctor")
		.description("check the install, the hooks, the database and capture health")
		.action(async () => {
			const code = await runDoctor();
			if (code !== 0) throw new ExitCode(code);
		});
}

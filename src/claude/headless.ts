// runClaude(): the only code that spawns `claude` (feature 15). Every call runs `claude -p` with the prompt on stdin
// after the sentinel line "[cc-debrief:<feature>]", CC_DEBRIEF_INTERNAL=1 and CC_DEBRIEF_FEATURE in its environment,
// no tools and no MCP servers, and never resumes the user's session: callers send the stored-turns prompt (review
// 2026-10-10). One ai_calls row is written before the spawn (the daily-cap ledger), one self_usage row from the result,
// and the transcript the call leaves in Claude Code's projects folder is deleted.
import { spawnSync } from "node:child_process";
import { rmSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { execa } from "execa";
import { estimateCost } from "../collector/prices";
import type { UsageTotals } from "../collector/transcript";
import type { Db } from "../db/adapter";
import { localDayStart, recordSelfUsage } from "../db/queries/selfUsage";
import { dataDir, ensureDir, projectsDir } from "../paths";
import type { AiFeature } from "../server/types";

export type { AiFeature };

const DEFAULT_TIMEOUT_MS = 120_000;

// The prompt carries untrusted session text (tool output, fetched pages) and no call needs a tool: --tools "" turns
// every built-in tool off and --strict-mcp-config without --mcp-config loads no MCP server; --json-schema output still
// works (probe C, review 2026-10-10). The budget caps one call's spend. It is checked after a turn is paid for, so a
// call over it fails ("budget") and is never retried. Flags from Claude Code 2.1.284 `claude --help`.
export const TOOL_LIMITS = ["--tools", "", "--strict-mcp-config", "--max-budget-usd", "0.50"];

export type ClaudeResult<T> = {
	result: T;
	sessionId: string;
	/** This call's own `usage` priced with PRICE_TABLE; null when the model is unknown. */
	costUsd: number | null;
	/** `total_cost_usd` as reported, for comparison (it would be cumulative with a resumed session, Phase 0 C4). */
	rawTotalCostUsd: number | null;
	usage: UsageTotals;
	model?: string;
};

export type ClaudeErrorReason = "not_found" | "capped" | "exit" | "timeout" | "parse" | "schema" | "budget";

export class ClaudeError extends Error {
	constructor(
		readonly reason: ClaudeErrorReason,
		message: string,
	) {
		super(message);
		this.name = "ClaudeError";
	}
}

export type RunClaudeOptions = {
	prompt: string;
	/** JSON Schema passed to --json-schema. */
	schema: object;
	feature: AiFeature;
	/** ai.model; unset = Claude Code's default. */
	model?: string;
	timeoutMs?: number;
	db: Db;
	/** The user session summarized or reviewed, for the ledger rows. */
	targetSessionId?: string;
	/** The feature's daily cap: the ai_calls row is reserved only while today's count is below it, else "capped". */
	cap?: number;
	now?: Date;
};

type RawUsage = {
	input_tokens?: number;
	output_tokens?: number;
	cache_creation_input_tokens?: number;
	cache_read_input_tokens?: number;
	cache_creation?: { ephemeral_1h_input_tokens?: number };
};
type RawResult = {
	is_error?: boolean;
	subtype?: string;
	result?: unknown;
	structured_output?: unknown;
	session_id?: unknown;
	total_cost_usd?: unknown;
	usage?: RawUsage;
	modelUsage?: Record<
		string,
		{ inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number }
	>;
};

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** The argument list, without the prompt (it goes on stdin; cmd.exe cannot pass a line break in an argument). */
export function claudeArgs(opts: Pick<RunClaudeOptions, "schema" | "model">): string[] {
	const args = ["-p", "--output-format", "json", "--json-schema", JSON.stringify(opts.schema), ...TOOL_LIMITS];
	if (opts.model) args.push("--model", opts.model);
	return args;
}

// The result carries no top-level model. A pinned alias ("haiku") is resolved to the full id modelUsage reports, so it
// can be priced; otherwise the model with the most output in modelUsage (this call only).
function resolveModel(opts: RunClaudeOptions, raw: RawResult): string | undefined {
	const keys = Object.keys(raw.modelUsage ?? {});
	if (opts.model) {
		const pin = opts.model.toLowerCase();
		return keys.find((k) => k.toLowerCase().includes(pin)) ?? opts.model;
	}
	let best: string | undefined;
	let bestOut = -1;
	for (const k of keys) {
		const out = num(raw.modelUsage?.[k]?.outputTokens);
		if (out > bestOut) [best, bestOut] = [k, out];
	}
	return best;
}

function structured(raw: RawResult): unknown {
	if (raw.structured_output !== undefined && raw.structured_output !== null) return raw.structured_output;
	if (typeof raw.result === "string") {
		try {
			const v = JSON.parse(raw.result);
			if (v !== null && typeof v === "object") return v;
		} catch {
			// plain text: no structured object
		}
	}
	return undefined;
}

const short = (s: unknown) =>
	String(s ?? "")
		.trim()
		.slice(0, 200);

/** Full path of an executable on PATH (PATHEXT on Windows), or null. Without it, a missing claude on Windows is
 * only a cmd.exe "is not recognized" message with exit code 1. */
export function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
	const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH");
	const dirs = ((pathKey && env[pathKey]) || "").split(delimiter).filter(Boolean);
	const exts = process.platform === "win32" ? (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
	for (const dir of dirs) {
		for (const ext of exts) {
			const candidate = join(dir, name + ext.toLowerCase());
			try {
				if (statSync(candidate).isFile()) return candidate;
			} catch {
				// not here
			}
		}
	}
	return null;
}

// On Windows the .cmd shim runs node under cmd.exe; killing cmd.exe alone leaves node holding the output pipes.
function killTree(sub: { pid?: number; kill(signal?: NodeJS.Signals): boolean }): void {
	if (process.platform === "win32" && sub.pid !== undefined) {
		spawnSync("taskkill", ["/pid", String(sub.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
		return;
	}
	sub.kill("SIGTERM");
	setTimeout(() => sub.kill("SIGKILL"), 2000).unref();
}

/**
 * The call's own token counts. A failed call (a budget error) reports `usage` as all zeros, so then they come from
 * `modelUsage`, which covers only this call because no call resumes (probe B, review 2026-10-10).
 */
function callUsage(raw: RawResult): { usage: UsageTotals; cacheCreation1hTokens: number } {
	const u = raw.usage ?? {};
	const usage: UsageTotals = {
		inputTokens: num(u.input_tokens),
		outputTokens: num(u.output_tokens),
		cacheCreationTokens: num(u.cache_creation_input_tokens),
		cacheReadTokens: num(u.cache_read_input_tokens),
	};
	if (usage.inputTokens + usage.outputTokens + usage.cacheCreationTokens + usage.cacheReadTokens > 0) {
		return { usage, cacheCreation1hTokens: num(u.cache_creation?.ephemeral_1h_input_tokens) };
	}
	for (const m of Object.values(raw.modelUsage ?? {})) {
		usage.inputTokens += num(m.inputTokens);
		usage.outputTokens += num(m.outputTokens);
		usage.cacheCreationTokens += num(m.cacheCreationInputTokens);
		usage.cacheReadTokens += num(m.cacheReadInputTokens);
	}
	// modelUsage does not split cache writes by lifetime; Claude Code writes 1-hour entries (Phase 0 C4).
	return { usage, cacheCreation1hTokens: usage.cacheCreationTokens };
}

/** Claude Code's project folder name for a working directory: every character but A-Z, a-z, 0-9 becomes "-". */
export const projectFolderName = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, "-");

/** The projects folder holding the transcripts of the tracker's own calls (they all run in dataDir()). */
export const callTranscriptsDir = (): string => join(projectsDir(), projectFolderName(dataDir()));

/** Deletes the transcript (and any per-session folder) a call left in the tracker's own projects folder. Never throws. */
function removeCallTranscript(cwd: string, sessionId: string): void {
	if (!/^[A-Za-z0-9-]{1,100}$/.test(sessionId)) return;
	const dir = join(projectsDir(), projectFolderName(cwd));
	for (const p of [join(dir, `${sessionId}.jsonl`), join(dir, sessionId)]) {
		try {
			rmSync(p, { recursive: true, force: true });
		} catch {
			// still held open by Claude Code: purge sweeps the folder later
		}
	}
}

/**
 * Inserts the call's ai_calls row; with a cap, only while today's (local day) count for the feature is below it. One
 * INSERT … SELECT runs under SQLite's write lock, so parallel workers cannot all pass the check (review B6). Null when
 * capped.
 */
function reserveCall(db: Db, opts: RunClaudeOptions): number | null {
	const now = opts.now ?? new Date();
	const start = localDayStart(now);
	const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
	const r = db
		.prepare(
			`INSERT INTO ai_calls (feature, target_session_id, ts)
			 SELECT ?, ?, ? WHERE ? IS NULL
			   OR (SELECT count(*) FROM ai_calls WHERE feature = ? AND ts >= ? AND ts < ?) < ?`,
		)
		.run(
			opts.feature,
			opts.targetSessionId ?? null,
			now.toISOString(),
			opts.cap ?? null,
			opts.feature,
			start.toISOString(),
			end.toISOString(),
			opts.cap ?? 0,
		);
	return r.changes === 0 ? null : Number(r.lastInsertRowid);
}

export async function runClaude<T>(opts: RunClaudeOptions): Promise<ClaudeResult<T>> {
	const { db } = opts;
	// Not found is not an attempt: nothing ran, so nothing counts against the daily cap.
	const exe = findOnPath("claude");
	if (exe === null) throw new ClaudeError("not_found", "claude is not on PATH");
	const callId = reserveCall(db, opts);
	if (callId === null) throw new ClaudeError("capped", "daily cap reached");

	// A call's transcript lands in the project folder of the working directory (Phase 0 C2): one folder for all of them.
	const cwd = dataDir();
	ensureDir(cwd);
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	let stdout: string;
	try {
		const sub = execa(exe, claudeArgs(opts), {
			cwd,
			input: `[cc-debrief:${opts.feature}]
${opts.prompt}`,
			env: { CC_DEBRIEF_INTERNAL: "1", CC_DEBRIEF_FEATURE: opts.feature },
			windowsHide: true,
			reject: false,
			stripFinalNewline: true,
		});
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			killTree(sub);
		}, timeoutMs);
		const r = await sub.finally(() => clearTimeout(timer));
		if (timedOut) throw new ClaudeError("timeout", `timeout after ${timeoutMs} ms`);
		if (r.exitCode !== 0) {
			throw new ClaudeError("exit", `exit ${r.exitCode ?? "?"}${r.stderr ? `: ${short(r.stderr)}` : ""}`);
		}
		stdout = String(r.stdout ?? "");
	} catch (e) {
		if (e instanceof ClaudeError) throw e;
		throw new ClaudeError("exit", short((e as Error).message));
	}

	let raw: RawResult;
	try {
		raw = JSON.parse(stdout) as RawResult;
		if (raw === null || typeof raw !== "object" || typeof raw.session_id !== "string") throw new Error("no session_id");
	} catch {
		throw new ClaudeError("parse", `not a JSON result: ${short(stdout)}`);
	}

	const sessionId = raw.session_id as string;
	removeCallTranscript(cwd, sessionId);
	const { usage, cacheCreation1hTokens } = callUsage(raw);
	const model = resolveModel(opts, raw);
	// The call's own usage priced with the table (Phase 0 C4), never total_cost_usd.
	const costUsd = model === undefined ? null : estimateCost({ model, ...usage, cacheCreation1hTokens });
	const base = {
		sessionId,
		costUsd,
		rawTotalCostUsd: typeof raw.total_cost_usd === "number" ? raw.total_cost_usd : null,
		usage,
		model,
	};
	db.transaction(() => {
		db.prepare("UPDATE ai_calls SET session_id = ? WHERE id = ?").run(sessionId, callId);
		recordSelfUsage(db, opts.feature, { ...base, result: null }, opts.targetSessionId);
	});

	if (raw.is_error) {
		const budget = raw.subtype?.startsWith("error_max_budget") === true;
		throw new ClaudeError(budget ? "budget" : "exit", `${raw.subtype ?? "error"}: ${short(raw.result)}`);
	}
	const result = structured(raw);
	if (result === undefined) throw new ClaudeError("schema", `no structured result: ${short(raw.result)}`);
	return { ...base, result: result as T };
}

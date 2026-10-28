import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";

/** What the fake answers a `-p` call with. An array scripts consecutive calls (the last entry repeats). */
export type FakeScenario = {
	/** Written to stdout; an object is JSON-encoded. Every "{{uuid}}" is replaced with a fresh UUID per call. */
	stdout?: string | object;
	stderr?: string;
	exitCode?: number;
	delayMs?: number;
};

export type FakeInvocation = {
	argv: string[];
	env: { CC_DEBRIEF_INTERNAL: string | null; CC_DEBRIEF_FEATURE: string | null };
	stdin: string;
};

export type FakeClaude = {
	/** Directory holding the `claude` stand-in; put it first on PATH. */
	dir: string;
	/** A copy of base with dir first on PATH (Windows spells the key Path; any spelling is replaced). */
	env(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
	/** Puts dir first on this process's PATH (for in-process runClaude); returns the restore function. */
	install(): () => void;
	/** Sets the answer to the next `-p` calls (default: a successful result with a summary object). */
	scenario(s: FakeScenario | FakeScenario[]): void;
	/** Argument lists of every call so far. */
	calls(): string[][];
	/** Every `-p` call: argv, the two internal env vars, and stdin. */
	invocations(): FakeInvocation[];
};

export const FAKE_SUMMARY = {
	summary: "Added a retry to the billing-api client. Tests pass.",
	session_type: "feature",
	tags: ["billing-api", "retry"],
	outcome: "completed",
};

/** A recap polish answer for the recap fixture's day (Phase 6 spec decision 6). */
export const FAKE_RECAP = {
	groups: [
		{ repo: "checkout-flow", items: ["Debugged the failed webhook retry", "Reworked the cart page"] },
		{ repo: "api-gateway", items: ["Added rate limiting to the public endpoints"] },
	],
};

/** A `claude -p --output-format json` result as Claude Code 2.1.284 prints it (Phase 0 C4 keys). */
export function successResult(structured: unknown = FAKE_SUMMARY, over: Record<string, unknown> = {}): object {
	return {
		type: "result",
		subtype: "success",
		is_error: false,
		duration_ms: 3800,
		num_turns: 1,
		result: JSON.stringify(structured),
		structured_output: structured,
		session_id: "{{uuid}}",
		total_cost_usd: 0.0123,
		usage: {
			input_tokens: 10,
			cache_creation_input_tokens: 1531,
			cache_read_input_tokens: 49643,
			output_tokens: 92,
			cache_creation: { ephemeral_1h_input_tokens: 1531, ephemeral_5m_input_tokens: 0 },
		},
		modelUsage: { "claude-haiku-4-5-20251001": { inputTokens: 10, outputTokens: 92, costUSD: 0.0123 } },
		...over,
	};
}

/**
 * A `claude` executable (Node script plus sh and cmd launchers) that records its arguments, answers `--version`, and
 * answers `-p` calls from a scenario file, logging argv, the internal env vars and stdin. Lets tests prove Phase 1
 * never calls `claude -p` and drive runClaude() without a real Claude Code.
 */
export function fakeClaude(parent: string): FakeClaude {
	const dir = join(parent, "fake-claude");
	mkdirSync(dir, { recursive: true });
	const log = join(dir, "calls.log");
	const inv = join(dir, "invocations.log");
	const scenarioFile = join(dir, "scenario.json");
	const script = join(dir, "claude.mjs");
	writeFileSync(
		script,
		`import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
if (args[0] === "--version") process.stdout.write("2.4.1 (Claude Code)\\n");
else if (args.includes("-p")) {
	let stdin = "";
	for await (const chunk of process.stdin) stdin += chunk;
	const env = { CC_DEBRIEF_INTERNAL: process.env.CC_DEBRIEF_INTERNAL ?? null, CC_DEBRIEF_FEATURE: process.env.CC_DEBRIEF_FEATURE ?? null };
	appendFileSync(${JSON.stringify(inv)}, JSON.stringify({ argv: args, env, stdin }) + "\\n");
	const file = process.env.FAKE_CLAUDE_SCENARIO || ${JSON.stringify(scenarioFile)};
	let sc = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
	if (Array.isArray(sc)) {
		const n = readFileSync(${JSON.stringify(inv)}, "utf8").split("\\n").filter(Boolean).length - 1;
		sc = sc[Math.min(n, sc.length - 1)] ?? {};
	}
	if (sc.delayMs) await new Promise((r) => setTimeout(r, sc.delayMs));
	if (sc.stdout !== undefined) {
		const text = typeof sc.stdout === "string" ? sc.stdout : JSON.stringify(sc.stdout);
		process.stdout.write(text.replaceAll("{{uuid}}", () => randomUUID()));
	}
	if (sc.stderr) process.stderr.write(sc.stderr);
	process.exitCode = sc.exitCode ?? 0;
}
`,
	);
	writeFileSync(scenarioFile, JSON.stringify({ stdout: successResult() }));
	const sh = join(dir, "claude");
	writeFileSync(sh, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
	chmodSync(sh, 0o755);
	writeFileSync(join(dir, "claude.cmd"), `@"${process.execPath}" "${script}" %*\r\n`);
	const readLog = <T>(path: string): T[] =>
		existsSync(path)
			? readFileSync(path, "utf8")
					.split("\n")
					.filter(Boolean)
					.map((l) => JSON.parse(l) as T)
			: [];
	const withDirFirst = (base: NodeJS.ProcessEnv) => {
		const pathKey = Object.keys(base).find((k) => k.toUpperCase() === "PATH");
		return { pathKey, value: `${dir}${delimiter}${(pathKey && base[pathKey]) || ""}` };
	};
	return {
		dir,
		env(base) {
			const { pathKey, value } = withDirFirst(base);
			const env = { ...base };
			if (pathKey) delete env[pathKey];
			env.PATH = value;
			return env;
		},
		install() {
			const { pathKey, value } = withDirFirst(process.env);
			const key = pathKey ?? "PATH";
			const saved = process.env[key];
			process.env[key] = value;
			return () => {
				if (saved === undefined) delete process.env[key];
				else process.env[key] = saved;
			};
		},
		scenario(s) {
			writeFileSync(scenarioFile, JSON.stringify(s));
		},
		calls: () => readLog<string[]>(log),
		invocations: () => readLog<FakeInvocation>(inv),
	};
}

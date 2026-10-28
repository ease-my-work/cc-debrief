import { chmodSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hookCommand } from "../../src/claude/settings";
import { tilde } from "../../src/commands/common";
import {
	type Check,
	gatherProbes,
	KNOWN_ATTACHMENT_TYPES,
	KNOWN_LINE_TYPES,
	type Probes,
	runChecks,
	runDoctor,
	timePatterns,
} from "../../src/commands/doctor";
import { runInit } from "../../src/commands/init";
import { unknownConfigKeys } from "../../src/config";
import { openDb } from "../../src/db/adapter";
import { migrate } from "../../src/db/migrate";
import { binDir, claudeSettingsPath, configPath, ensureDir, hookErrorsLogPath } from "../../src/paths";
import { fakeClaude } from "../helpers/fake-claude";
import { fixtureJsonlFiles, writeTranscript } from "../helpers/fixtures";
import { type TmpHome, tmpHome } from "../helpers/tmp-home";

const NOW = new Date("2026-09-30T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const MIN = 60_000;
const DAY = 86_400_000;
const CMD = hookCommand("/home/u/.cc-debrief/bin/hook.js");

// A healthy install; each case overrides what it tests.
function probes(over: Partial<Probes> = {}): Probes {
	return {
		now: NOW,
		nodeVersion: "22.14.0",
		claudeVersion: () => ({ found: true, version: "2.4.1" }),
		internalEnv: false,
		packageVersion: "0.1.0",
		permissionHook: true,
		retentionDays: 90,
		settings: {
			path: "/home/u/.claude/settings.json",
			error: null,
			cleanupPeriodDays: null,
			entries: [
				{ event: "SessionStart", command: CMD },
				{ event: "Stop", command: CMD, async: true },
				{ event: "PermissionRequest", command: CMD },
				{ event: "SessionEnd", command: CMD, timeout: 3600 },
			],
		},
		expectedCommand: CMD,
		bin: { hookJs: true, cliJs: true, version: "0.1.0" },
		hookRunMs: () => 60,
		db: { ok: true, path: "/home/u/.cc-debrief/tracker.db", bytes: 84.2 * 1024 * 1024 },
		config: { errors: [], unknownKeys: [], redact: [{ pattern: "@default", ms: 0.4 }] },
		parse: { sessions: 20, lines: 2051, errors: 0, unknownTypes: [] },
		transcripts: { onDisk: 283, backlog: 0, changedLast7d: true, lastIngestAt: ago(2 * MIN) },
		lastHookEventAt: ago(2 * MIN),
		hookErrors24h: 0,
		fileModes: [],
		pendingEnrich: 0,
		summariesEnabled: true,
		summaries: { pending: 0, errors7d: 0, topError: null, modelRejected: null },
		...over,
	};
}
const find = (checks: Check[], id: string) => checks.find((c) => c.id === id);
const status = (over: Partial<Probes>, id: string) => find(runChecks(probes(over)), id);
const entries = (drop: string[] = [], extra: Probes["settings"]["entries"] = []) => ({
	...probes().settings,
	entries: [...probes().settings.entries.filter((e) => !drop.includes(e.event)), ...extra],
});

describe("runChecks", () => {
	it("passes everything on a healthy install", () => {
		const checks = runChecks(probes());
		expect(checks.filter((c) => c.status !== "PASS")).toEqual([]);
		expect(find(checks, "node")?.message).toBe("Node 22.14.0 (>= 22.13)");
		expect(find(checks, "claude")?.message).toBe("claude 2.4.1 on PATH");
		expect(find(checks, "hooks")?.message).toBe(`4/4 hook entries in ${tilde("/home/u/.claude/settings.json")}`);
		expect(find(checks, "db")?.message).toBe(`DB writable (${tilde("/home/u/.cc-debrief/tracker.db")}, 84.2 MB)`);
		expect(find(checks, "parse")?.message).toBe("transcript parse failures 0.0% (0 of 2,051 lines, last 20 sessions)");
		expect(find(checks, "internal-env")).toBeUndefined();
	});

	it.each<[string, Partial<Probes>, string, Check["status"], RegExp?]>([
		["old Node", { nodeVersion: "22.12.9" }, "node", "FAIL"],
		["Node 23", { nodeVersion: "23.0.0" }, "node", "PASS"],
		// Summaries need claude on PATH; with them off, a desktop-only user may have none.
		["no claude", { claudeVersion: () => ({ found: false, version: null }) }, "claude", "FAIL", /not found on PATH/],
		[
			"no claude, summaries off",
			{ claudeVersion: () => ({ found: false, version: null }), summariesEnabled: false },
			"claude",
			"WARN",
			/summaries are off/,
		],
		[
			"many pending summaries",
			{ summaries: { pending: 21, errors7d: 0, topError: null, modelRejected: null } },
			"summaries",
			"WARN",
			/21 summaries pending.*enrich/,
		],
		[
			"20 pending is fine",
			{ summaries: { pending: 20, errors7d: 0, topError: null, modelRejected: null } },
			"summaries",
			"PASS",
		],
		[
			"recent summary failures",
			{ summaries: { pending: 0, errors7d: 3, topError: "exit 1", modelRejected: null } },
			"summaries",
			"WARN",
			/3 summary failures in 7 days \(most common: exit 1\)/,
		],
		["summaries off", { summariesEnabled: false }, "summaries", "PASS", /off/],
		[
			"model rejected",
			{ summaries: { pending: 0, errors7d: 1, topError: "exit 1", modelRejected: "haiku-9: exit 1: invalid model" } },
			"model",
			"WARN",
			/ai\.model .*haiku-9/,
		],
		["claude without version", { claudeVersion: () => ({ found: true, version: null }) }, "claude", "WARN"],
		["invalid settings", { settings: { ...probes().settings, error: "not valid JSON" } }, "hooks", "FAIL"],
		["a missing event", { settings: entries(["SessionEnd"]) }, "hooks", "FAIL", /SessionEnd/],
		[
			"Stop without async",
			{ settings: entries(["Stop"], [{ event: "Stop", command: CMD }]) },
			"hooks",
			"FAIL",
			/async/,
		],
		["bin/cli.js missing", { bin: { hookJs: true, cliJs: false, version: "0.1.0" } }, "hooks", "FAIL", /cli\.js/],
		["old bin copy", { bin: { hookJs: true, cliJs: true, version: "0.0.9" } }, "hooks", "WARN", /init/],
		["stale event", { settings: entries([], [{ event: "PreToolUse", command: CMD }]) }, "hooks", "WARN", /PreToolUse/],
		["PermissionRequest left while the key is off", { permissionHook: false }, "hooks", "WARN", /PermissionRequest/],
		["3 of 3 with the key off", { permissionHook: false, settings: entries(["PermissionRequest"]) }, "hooks", "PASS"],
		[
			"not installed",
			{ settings: { ...probes().settings, entries: [] }, bin: { hookJs: false, cliJs: false, version: null } },
			"hooks",
			"WARN",
			/read-only/,
		],
		["slow hook", { hookRunMs: () => 212 }, "hook-time", "WARN", /capture\.permissionHook false/],
		["untimed hook", { hookRunMs: () => null }, "hook-time", "WARN"],
		["DB failure", { db: { ok: false, path: "/x/tracker.db", error: "disk I/O error" } }, "db", "FAIL", /disk I\/O/],
		[
			"invalid config",
			{ config: { errors: [{ key: "retention.days", message: "too big" }], unknownKeys: [], redact: [] } },
			"config",
			"FAIL",
		],
		[
			"unknown config key",
			{ config: { errors: [], unknownKeys: ["ai.nope"], redact: [] } },
			"config",
			"WARN",
			/ai\.nope/,
		],
		[
			"invalid redact pattern",
			{ config: { errors: [], unknownKeys: [], redact: [{ pattern: "(", ms: null }] } },
			"config",
			"WARN",
		],
		[
			"slow redact pattern",
			{ config: { errors: [], unknownKeys: [], redact: [{ pattern: "(a+)+b", ms: 12 }] } },
			"config",
			"WARN",
			/5 ms/,
		],
		["parse 1.8%", { parse: { sessions: 20, lines: 2051, errors: 37, unknownTypes: [] } }, "parse", "WARN", /1\.8%/],
		["parse 12%", { parse: { sessions: 20, lines: 100, errors: 12, unknownTypes: [] } }, "parse", "FAIL"],
		[
			"unknown line type",
			{ parse: { sessions: 3, lines: 100, errors: 0, unknownTypes: [{ type: "turn-companion", version: "2.5.0" }] } },
			"parse",
			"WARN",
			/"turn-companion" \(Claude Code 2\.5\.0\)/,
		],
		["nothing ingested yet", { parse: { sessions: 0, lines: 0, errors: 0, unknownTypes: [] } }, "parse", "PASS"],
		["backlog", { transcripts: { ...probes().transcripts, backlog: 3 } }, "backlog", "WARN", /cc-debrief ingest/],
		["cleanup shorter", { settings: { ...probes().settings, cleanupPeriodDays: 30 } }, "cleanup", "WARN"],
		["cleanup longer", { settings: { ...probes().settings, cleanupPeriodDays: 365 } }, "cleanup", "PASS"],
		[
			"old last ingest",
			{ transcripts: { ...probes().transcripts, lastIngestAt: ago(8 * DAY) } },
			"last-ingest",
			"WARN",
		],
		[
			"transcripts never ingested",
			{ transcripts: { ...probes().transcripts, lastIngestAt: null } },
			"last-ingest",
			"WARN",
		],
		[
			"no transcripts at all",
			{ transcripts: { onDisk: 0, backlog: 0, changedLast7d: false, lastIngestAt: null } },
			"last-ingest",
			"PASS",
		],
		["hook not firing", { lastHookEventAt: ago(9 * DAY) }, "last-hook-event", "WARN", /not firing/],
		[
			"quiet week",
			{ lastHookEventAt: ago(9 * DAY), transcripts: { ...probes().transcripts, changedLast7d: false } },
			"last-hook-event",
			"PASS",
		],
		["hook errors", { hookErrors24h: 2 }, "hook-errors", "WARN", /2 hook errors/],
		[
			"loose modes",
			{ fileModes: [{ path: "/home/u/.cc-debrief", mode: 0o755, want: 0o700 }] },
			"file-modes",
			"WARN",
			/0755/,
		],
		["Windows modes", { fileModes: null }, "file-modes", "PASS", /not applicable/],
		["pending enrich", { pendingEnrich: 4 }, "pending", "WARN", /cc-debrief enrich/],
		["internal env", { internalEnv: true }, "internal-env", "WARN", /CC_DEBRIEF_INTERNAL/],
	])("%s", (_name, over, id, want, message) => {
		const c = status(over, id);
		expect(c?.status).toBe(want);
		if (message) expect(c?.message).toMatch(message);
	});

	it("does not time the hook when hooks are not installed", () => {
		let timed = false;
		const checks = runChecks(
			probes({
				settings: { ...probes().settings, entries: [] },
				bin: { hookJs: false, cliJs: false, version: null },
				hookRunMs: () => {
					timed = true;
					return 1;
				},
			}),
		);
		expect(timed).toBe(false);
		expect(find(checks, "hook-time")).toBeUndefined();
		expect(find(checks, "last-hook-event")).toBeUndefined();
	});
});

describe("known types", () => {
	it("include every line and attachment type in the fixtures", async () => {
		const { readFileSync } = await import("node:fs");
		for (const f of fixtureJsonlFiles()) {
			for (const raw of readFileSync(f, "utf8").split("\n")) {
				if (!raw.trim()) continue;
				const line = JSON.parse(raw);
				expect(KNOWN_LINE_TYPES.has(line.type), `${line.type} in ${f}`).toBe(true);
				if (line.type === "attachment") {
					expect(KNOWN_ATTACHMENT_TYPES.has(line.attachment.type), `${line.attachment.type} in ${f}`).toBe(true);
				}
			}
		}
		for (const t of ["queue-operation", "pr-link", "bridge-session", "relocated", "file-history-delta"]) {
			expect(KNOWN_LINE_TYPES.has(t)).toBe(true);
		}
		for (const t of ["async_hook_response", "edited_text_file", "hook_success", "silent_turn_reminder"]) {
			expect(KNOWN_ATTACHMENT_TYPES.has(t)).toBe(true);
		}
	});
});

let h: TmpHome;
beforeEach(() => {
	h = tmpHome();
});
afterEach(() => h.cleanup());

describe("unknownConfigKeys", () => {
	it("lists keys no setting uses, without descending into them", () => {
		ensureDir(h.home);
		writeFileSync(
			configPath(),
			JSON.stringify({ ai: { maxPerDay: 5, nope: 1 }, extra: { a: 1 }, capture: { redact: ["x"] } }),
		);
		expect(unknownConfigKeys()).toEqual(["ai.nope", "extra"]);
	});
});

describe("gatherProbes", () => {
	it("does not count a never-ingested transcript whose last line is older than retention as backlog", async () => {
		const old = new Date(Date.now() - 120 * 86_400_000).toISOString();
		const fresh = new Date(Date.now() - 2 * 86_400_000).toISOString();
		const line = (ts: string, uuid: string) => ({ type: "user", uuid, timestamp: ts, message: { content: "hi" } });
		const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000);
		// Touched recently (mtime inside the window), but its last line is 120 days old: ingest skips it.
		const stale = writeTranscript(h.claude, "p", "aaaaaaaa-0000-4000-8000-000000000001", [
			line(old, "a"),
			line(old, "b"),
		]);
		const pending = writeTranscript(h.claude, "p", "aaaaaaaa-0000-4000-8000-000000000002", [line(fresh, "c")]);
		utimesSync(stale, twoHoursAgo, twoHoursAgo);
		utimesSync(pending, twoHoursAgo, twoHoursAgo);
		const p = await gatherProbes();
		expect(p.transcripts).toMatchObject({ onDisk: 2, backlog: 1 });
	});

	it("counts only sessions with transcripts for the parse rate and finds unknown types", async () => {
		const db = openDb();
		migrate(db);
		db.exec(`INSERT INTO sessions (session_id, started_at, cc_version) VALUES
			('snap-only', '2026-09-30T11:00:00Z', NULL), ('s1', '2026-09-30T10:00:00Z', '2.5.0')`);
		db.exec(`INSERT INTO transcripts (id, path, session_id, size, mtime_ms, lines, parse_errors)
			VALUES (1, '/p/s1.jsonl', 's1', 10, 1, 50, 1)`);
		db.exec(`INSERT INTO transcript_lines (session_id, file_id, line_no, type, subtype, payload) VALUES
			('s1', 1, 0, 'user', NULL, x'00'), ('s1', 1, 1, 'turn-companion', NULL, x'00'),
			('s1', 1, 2, 'attachment', 'shiny_new', x'00'), ('s1', 1, 3, 'attachment', 'hook_success', x'00')`);
		db.exec(
			`INSERT INTO events (session_id, event, ts, payload) VALUES ('s1', 'SessionStart', '2026-09-30T10:00:00Z', '{}')`,
		);
		db.close();
		ensureDir(h.home);
		writeFileSync(hookErrorsLogPath(), `${new Date().toISOString()}\tStop\tboom\n2020-01-01T00:00:00.000Z\t-\told\n`);

		const p = await gatherProbes();
		expect(p.parse).toMatchObject({ sessions: 1, lines: 50, errors: 1 });
		expect(p.parse.unknownTypes).toEqual([
			{ type: "turn-companion", version: "2.5.0" },
			{ type: "attachment:shiny_new", version: "2.5.0" },
		]);
		expect(p.lastHookEventAt).toBe("2026-09-30T10:00:00Z");
		expect(p.hookErrors24h).toBe(1);
		expect(p.db.ok).toBe(true);
		expect(p.settings.entries).toEqual([]);
	});

	it("times one hook run in internal mode, so the hook starts no worker", async () => {
		ensureDir(binDir());
		const seen = join(h.home, "seen.json");
		writeFileSync(
			join(binDir(), "hook.js"),
			`let s = ""; process.stdin.on("data", (d) => (s += d)); process.stdin.on("end", () => {
				require("node:fs").writeFileSync(${JSON.stringify(seen)}, JSON.stringify({
					internal: process.env.CC_DEBRIEF_INTERNAL, event: JSON.parse(s).hook_event_name }));
			});`,
		);
		const p = await gatherProbes();
		expect(p.hookRunMs()).toEqual(expect.any(Number));
		expect(JSON.parse(readFileSync(seen, "utf8"))).toEqual({ internal: "1", event: "Stop" });
	});

	it.runIf(process.platform !== "win32")("reports loose file modes", async () => {
		ensureDir(h.home);
		chmodSync(h.home, 0o755);
		const p = await gatherProbes();
		expect(p.fileModes).toContainEqual({ path: h.home, mode: 0o755, want: 0o700 });
	});
});

describe("cc-debrief doctor", () => {
	it("passes every check on a freshly initialised home", async () => {
		const pkg = join(h.claude, "..", "pkg");
		mkdirSync(pkg);
		writeFileSync(join(pkg, "hook.js"), "");
		writeFileSync(join(pkg, "cli.js"), "");
		await runInit({ backfill: true, packageDir: pkg, out: () => {} });
		const fake = fakeClaude(join(h.claude, ".."));
		const lines: string[] = [];
		const code = await runDoctor({ out: (l) => void lines.push(l), env: fake.env(process.env), hookRunMs: () => 40 });
		expect(lines.filter((l) => !l.startsWith("PASS  ")).slice(0, -1)).toEqual([]);
		expect(lines.at(-1)).toBe("0 warnings, 0 failures");
		expect(code).toBe(0);
		expect(lines.join("\n")).toContain(`hook entries in`);
		expect(fake.calls()).toEqual([["--version"]]);
	});

	it("exits 1 when a check fails", async () => {
		ensureDir(h.home);
		writeFileSync(claudeSettingsPath(), "{ nope");
		const fake = fakeClaude(join(h.claude, ".."));
		const lines: string[] = [];
		const code = await runDoctor({ out: (l) => void lines.push(l), env: fake.env(process.env), hookRunMs: () => 40 });
		expect(code).toBe(1);
		expect(lines).toContainEqual(expect.stringMatching(/^FAIL {2}.*settings\.json/));
		expect(lines.at(-1)).toMatch(/^\d+ warnings?, 1 failure$/);
	});
});

describe("timePatterns", () => {
	/** A clock whose timed runs take the given durations in turn (two reads per run). */
	const clockOf = (durations: number[]) => {
		let now = 0;
		let reads = 0;
		return () => {
			if (reads++ % 2 === 1) now += durations[((reads - 2) / 2) % durations.length];
			return now;
		};
	};

	it("keeps the fastest run, so one pause does not read as a slow pattern", () => {
		expect(timePatterns(["x+"], clockOf([50, 1, 1]))).toEqual([{ pattern: "x+", ms: 1 }]);
	});

	it("still reports a pattern that is slow on every run", () => {
		expect(timePatterns(["x+"], clockOf([12, 13, 12]))).toEqual([{ pattern: "x+", ms: 12 }]);
	});

	it("gives null for a pattern that does not compile", () => {
		expect(timePatterns(["("])).toEqual([{ pattern: "(", ms: null }]);
	});
});

describe("~/.claude/projects size (Phase 7 P11)", () => {
	it("prints the size next to the DB line", () => {
		expect(status({ projects: { bytes: 1.5 * 1024 * 1024 * 1024, cut: false } }, "projects")).toEqual({
			id: "projects",
			status: "PASS",
			message: "Claude Code transcripts (~/.claude/projects): 1.5 GB",
		});
	});
	it("says at least when the walk was cut", () => {
		expect(status({ projects: { bytes: 2 * 1024 * 1024 * 1024, cut: true } }, "projects")?.message).toBe(
			"Claude Code transcripts (~/.claude/projects): ≥ 2.0 GB (stopped after 2 s)",
		);
	});
});

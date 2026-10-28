import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HOOK_MARKER, SettingsError } from "../../src/claude/settings";
import { runInit } from "../../src/commands/init";
import { runUninit } from "../../src/commands/uninit";
import { setConfigValue } from "../../src/config";
import { openDb } from "../../src/db/adapter";
import { binDir, claudeSettingsPath, configPath, dbPath } from "../../src/paths";
import { VERSION } from "../../src/version";
import { standardUserTree } from "../helpers/claude-tree";
import { copyFixtureInto, loadFixtureCases } from "../helpers/fixtures";
import { runCaptured } from "../helpers/run-cli";
import { type TmpHome, tmpHome } from "../helpers/tmp-home";

let h: TmpHome;
let pkg: string;
let lines: string[];
const out = (l: string) => void lines.push(l);
beforeEach(() => {
	h = tmpHome();
	lines = [];
	// A stand-in for the installed package's dist/ directory.
	pkg = join(h.claude, "..", "pkg");
	mkdirSync(pkg, { recursive: true });
	writeFileSync(join(pkg, "hook.js"), "// hook\n");
	writeFileSync(join(pkg, "cli.js"), "// cli\n");
});
afterEach(() => h.cleanup());

type Obj = Record<string, unknown>;
const settings = () => JSON.parse(readFileSync(claudeSettingsPath(), "utf8")) as { hooks: Record<string, Obj[]> };
const ourHooks = (event: string) =>
	(settings().hooks?.[event] ?? []).flatMap((g) =>
		(g.hooks as Obj[]).filter((x) => String(x.command).includes(HOOK_MARKER)),
	);
function meta(key: string): string | null {
	const db = openDb();
	try {
		return db.prepare("SELECT value FROM meta WHERE key = ?").get<{ value: string }>(key)?.value ?? null;
	} finally {
		db.close();
	}
}
function count(table: string): number {
	const db = openDb();
	try {
		return db.prepare(`SELECT count(*) AS n FROM ${table}`).get<{ n: number }>()?.n ?? 0;
	} finally {
		db.close();
	}
}
const ORIGINAL =
	'{\n  "model": "opus",\n  "hooks": {\n    "Stop": [\n      { "hooks": [ { "type": "command", "command": "echo mine" } ] }\n    ]\n  }\n}\n';

describe("init", () => {
	it("installs four hooks, backs up settings, records meta, copies bin/ and imports existing sessions", async () => {
		const cases = loadFixtureCases().slice(0, 2);
		for (const c of cases) copyFixtureInto(h.claude, c.caseDir);
		writeFileSync(claudeSettingsPath(), ORIGINAL);

		await runInit({ backfill: true, packageDir: pkg, out, tty: false });

		for (const e of ["SessionStart", "Stop", "PermissionRequest", "SessionEnd"]) {
			expect(ourHooks(e), e).toHaveLength(1);
			expect(ourHooks(e)[0].command).toBe(`node "${join(binDir(), "hook.js")}" ${HOOK_MARKER}`);
		}
		expect(ourHooks("Stop")[0].async).toBe(true);
		expect(ourHooks("SessionEnd")[0].timeout).toBe(3600);
		expect(settings().hooks.Stop[0]).toEqual({ hooks: [{ type: "command", command: "echo mine" }] });

		const backup = meta("init.backup_path");
		expect(backup && readFileSync(backup, "utf8")).toBe(ORIGINAL);
		expect(meta("init.before_sha256")).toMatch(/^[0-9a-f]{64}$/);
		expect(meta("init.after_sha256")).toMatch(/^[0-9a-f]{64}$/);
		expect(JSON.parse(meta("init.created") ?? "null")).toEqual([
			"hooks.SessionStart",
			"hooks.PermissionRequest",
			"hooks.SessionEnd",
		]);

		expect(readFileSync(join(binDir(), "hook.js"), "utf8")).toBe("// hook\n");
		expect(readFileSync(join(binDir(), "cli.js"), "utf8")).toBe("// cli\n");
		expect(readFileSync(join(binDir(), "version"), "utf8").trim()).toBe(VERSION);
		expect(JSON.parse(readFileSync(configPath(), "utf8"))).toEqual({});
		expect(count("sessions")).toBe(2);

		const text = lines.join("\n");
		expect(text).toMatch(/^Data dir +\S.*\(created\)$/m);
		expect(text).toMatch(/^Database +\S.*tracker\.db \(schema v9\)$/m);
		expect(text).toContain(`(v${VERSION} copied)`);
		expect(text).toMatch(/^ {2}added +4 hooks: SessionStart, Stop \(async\), PermissionRequest, SessionEnd$/m);
		expect(text).toMatch(/^ {2}skipped +0 \(already present\)$/m);
		expect(text).toMatch(/^History +imported 2 sessions .* · no AI used$/m);
		const history = lines.findIndex((l) => l.startsWith("History"));
		expect(lines.slice(history + 1, history + 4)).toEqual([
			"AI summaries are ON for new sessions: each finished session makes one `claude -p` call",
			"on your plan (max 50/day). Turn off: cc-debrief config set ai.summaries.enabled false",
			expect.stringMatching(
				/^Imported sessions are not summarized\. To summarize some: cc-debrief enrich --ai --since \d{4}-\d{2}-\d{2}$/,
			),
		]);
	});

	it("prints the AI notice for the configured cap, and the off state", async () => {
		setConfigValue("ai.maxPerDay", "20");
		await runInit({ backfill: false, packageDir: pkg, out, tty: false });
		expect(lines).toContain("on your plan (max 20/day). Turn off: cc-debrief config set ai.summaries.enabled false");
		expect(lines.some((l) => l.startsWith("Imported sessions"))).toBe(false); // nothing imported
		lines = [];
		setConfigValue("ai.summaries.enabled", "false");
		await runInit({ backfill: false, packageDir: pkg, out, tty: false });
		expect(lines).toContain("AI summaries are OFF. Turn on: cc-debrief config set ai.summaries.enabled true");
	});

	it("runs a first user-level scan and prints the Inventory line before History", async () => {
		standardUserTree(h.claude);
		await runInit({ backfill: false, packageDir: pkg, out, tty: false });
		const text = lines.join("\n");
		expect(text).toMatch(/^Inventory +2 user skills, 2 plugins, 2 MCP servers, 1 hook set$/m);
		expect(text.indexOf("Inventory")).toBeLessThan(text.indexOf("History"));
		expect(meta("last_scan_user")).toEqual(expect.any(String));
		expect(count("inventory")).toBeGreaterThan(0);
	});

	it("--no-backfill imports nothing", async () => {
		copyFixtureInto(h.claude, loadFixtureCases()[0].caseDir);
		await runInit({ backfill: false, packageDir: pkg, out, tty: false });
		expect(count("sessions")).toBe(0);
		expect(lines.join("\n")).toMatch(/^History +not imported \(--no-backfill\)/m);
	});

	it("keeps an existing config.json", async () => {
		setConfigValue("retention.days", "30");
		await runInit({ backfill: false, packageDir: pkg, out });
		expect(JSON.parse(readFileSync(configPath(), "utf8"))).toEqual({ retention: { days: 30 } });
	});

	it("follows capture.permissionHook: off removes the PermissionRequest entry, on adds it back", async () => {
		await runInit({ backfill: false, packageDir: pkg, out });
		setConfigValue("capture.permissionHook", "false");
		lines = [];
		await runInit({ backfill: false, packageDir: pkg, out });
		expect(ourHooks("PermissionRequest")).toEqual([]);
		expect(lines.join("\n")).toMatch(/^ {2}removed +1 hook: PermissionRequest/m);
		expect(lines.join("\n")).toMatch(/^ {2}skipped +3 \(already present\)$/m);

		setConfigValue("capture.permissionHook", "true");
		lines = [];
		await runInit({ backfill: false, packageDir: pkg, out });
		expect(ourHooks("PermissionRequest")).toHaveLength(1);
		expect(lines.join("\n")).toMatch(/^ {2}added +1 hook: PermissionRequest$/m);
	});

	it("a second init skips all four and leaves the settings bytes and meta alone", async () => {
		writeFileSync(claudeSettingsPath(), ORIGINAL);
		await runInit({ backfill: false, packageDir: pkg, out });
		const bytes = readFileSync(claudeSettingsPath());
		const backup = meta("init.backup_path");
		lines = [];
		await runInit({ backfill: false, packageDir: pkg, out });
		expect(readFileSync(claudeSettingsPath()).equals(bytes)).toBe(true);
		expect(lines.join("\n")).toMatch(/^ {2}skipped +4 \(already present\)$/m);
		expect(lines.join("\n")).toMatch(/^ {2}added +0 hooks$/m);
		expect(meta("init.backup_path")).toBe(backup);
	});

	it("refuses an invalid settings.json (SettingsError, exit 3 in runCli) and leaves it untouched", async () => {
		const bad = '{ "model": "opus", }\n';
		writeFileSync(claudeSettingsPath(), bad);
		await expect(runInit({ backfill: false, packageDir: pkg, out })).rejects.toThrow(SettingsError);
		await expect(runInit({ backfill: false, packageDir: pkg, out })).rejects.toThrow(claudeSettingsPath());
		expect(readFileSync(claudeSettingsPath(), "utf8")).toBe(bad);
		expect(meta("init.after_sha256")).toBeNull();
	});
});

describe("uninit", () => {
	it("right after init restores the original bytes, removes bin/ and keeps the DB", async () => {
		writeFileSync(claudeSettingsPath(), ORIGINAL);
		await runInit({ backfill: false, packageDir: pkg, out });
		lines = [];
		runUninit({ out });
		expect(readFileSync(claudeSettingsPath(), "utf8")).toBe(ORIGINAL);
		expect(existsSync(binDir())).toBe(false);
		expect(existsSync(dbPath())).toBe(true);
		expect(lines[0]).toMatch(/^Removed 4 hooks from .*settings\.json \(restored original bytes\)$/);
		expect(lines.join("\n")).toContain("Your data is kept in");
		expect(meta("init.after_sha256")).toBeNull();
	});

	it("deletes settings.json when init created it", async () => {
		await runInit({ backfill: false, packageDir: pkg, out });
		expect(existsSync(claudeSettingsPath())).toBe(true);
		runUninit({ out });
		expect(existsSync(claudeSettingsPath())).toBe(false);
	});

	it("after a permissionHook off/on round trip still restores the original bytes", async () => {
		writeFileSync(claudeSettingsPath(), ORIGINAL);
		await runInit({ backfill: false, packageDir: pkg, out });
		setConfigValue("capture.permissionHook", "false");
		await runInit({ backfill: false, packageDir: pkg, out });
		setConfigValue("capture.permissionHook", "true");
		await runInit({ backfill: false, packageDir: pkg, out });
		runUninit({ out });
		expect(readFileSync(claudeSettingsPath(), "utf8")).toBe(ORIGINAL);
	});

	it("after the user edited settings removes only our entries and keeps the edit", async () => {
		writeFileSync(claudeSettingsPath(), ORIGINAL);
		await runInit({ backfill: false, packageDir: pkg, out });
		const edited = readFileSync(claudeSettingsPath(), "utf8").replace('"model": "opus"', '"model": "sonnet"');
		writeFileSync(claudeSettingsPath(), edited);
		lines = [];
		runUninit({ out });
		expect(readFileSync(claudeSettingsPath(), "utf8")).toBe(ORIGINAL.replace('"opus"', '"sonnet"'));
		expect(lines[0]).toMatch(/^Removed 4 hooks from .*settings\.json \(other changes kept\)$/);
	});

	it("says nothing to remove when there is no settings.json", async () => {
		const r = await runCaptured("uninit");
		expect(r.code).toBe(0);
		expect(r.stdout).toContain("nothing to remove");
		expect(existsSync(dbPath())).toBe(false); // uninit never creates a DB
	});

	it("refuses an invalid settings.json with exit 3", async () => {
		writeFileSync(claudeSettingsPath(), "{ nope");
		const r = await runCaptured("uninit");
		expect(r.code).toBe(3);
		expect(readFileSync(claudeSettingsPath(), "utf8")).toBe("{ nope");
	});
});

// Creating symlinks needs a privilege on Windows; the case runs wherever the OS allows it (Linux, macOS, CI).
const canSymlink = (() => {
	const dir = mkdtempSync(join(tmpdir(), "ccd-link-"));
	try {
		writeFileSync(join(dir, "t"), "");
		symlinkSync(join(dir, "t"), join(dir, "l"));
		return true;
	} catch {
		return false;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
})();

describe.skipIf(!canSymlink)("a symlinked settings.json", () => {
	it("init and uninit write through the link to its target and keep the link", async () => {
		const target = join(h.claude, "..", "dotfiles", "settings.json");
		mkdirSync(join(h.claude, "..", "dotfiles"));
		writeFileSync(target, ORIGINAL);
		symlinkSync(target, claudeSettingsPath());

		await runInit({ backfill: false, packageDir: pkg, out });
		expect(lstatSync(claudeSettingsPath()).isSymbolicLink()).toBe(true);
		expect(readFileSync(target, "utf8")).toContain(HOOK_MARKER);

		runUninit({ out });
		expect(lstatSync(claudeSettingsPath()).isSymbolicLink()).toBe(true);
		expect(readFileSync(target, "utf8")).toBe(ORIGINAL);
	});

	it("uninit's structural path also keeps the link", async () => {
		const target = join(h.claude, "..", "dotfiles", "settings.json");
		mkdirSync(join(h.claude, "..", "dotfiles"));
		writeFileSync(target, ORIGINAL);
		symlinkSync(target, claudeSettingsPath());
		await runInit({ backfill: false, packageDir: pkg, out });
		writeFileSync(target, readFileSync(target, "utf8").replace('"opus"', '"sonnet"'));
		runUninit({ out });
		expect(lstatSync(claudeSettingsPath()).isSymbolicLink()).toBe(true);
		expect(readFileSync(target, "utf8")).toBe(ORIGINAL.replace('"opus"', '"sonnet"'));
	});
});

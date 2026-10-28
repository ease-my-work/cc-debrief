import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInit } from "../../src/commands/init";
import { runPurge } from "../../src/commands/purge";
import { runUninit } from "../../src/commands/uninit";
import type { Db } from "../../src/db/adapter";
import { claudeSettingsPath, hookErrorsLogPath, rawDir } from "../../src/paths";
import { runCaptured } from "../helpers/run-cli";
import { seedDb, storeLines } from "../helpers/seed";
import { type TmpHome, tmpHome } from "../helpers/tmp-home";

const DAY = 86_400_000;
let h: TmpHome;
let db: Db;
beforeEach(() => {
	h = tmpHome();
	db = seedDb();
	for (const [id, age] of [
		["old", 100],
		["new", 10],
	] as const) {
		const ts = new Date(Date.now() - age * DAY).toISOString();
		db.prepare("INSERT INTO sessions (session_id, started_at) VALUES (?, ?)").run(id, ts);
		storeLines(db, id, [
			{ type: "user", uuid: `${id}-1`, timestamp: ts, message: { content: "x".repeat(2000) } },
			{ type: "user", uuid: `${id}-2`, timestamp: ts, message: { content: "y" } },
		]);
	}
});
afterEach(() => {
	db.close();
	h.cleanup();
});

const sessions = () =>
	db
		.prepare("SELECT session_id FROM sessions ORDER BY session_id")
		.all<{ session_id: string }>()
		.map((r) => r.session_id);

describe("cc-debrief purge", () => {
	it("--dry-run prints what would go and deletes nothing", async () => {
		const r = await runCaptured("purge", "--dry-run");
		expect(r.code).toBe(0);
		expect(r.stdout).toMatch(/^would delete 1 session older than 90 days \(2 transcript lines, \d+\.\d MB\)\n$/);
		expect(sessions()).toEqual(["new", "old"]);
	});

	it("deletes sessions older than retention.days", async () => {
		const r = await runCaptured("purge");
		expect(r.code).toBe(0);
		expect(r.stdout).toMatch(/^deleted 1 session older than 90 days \(2 transcript lines, \d+\.\d MB\)\n$/);
		expect(sessions()).toEqual(["new"]);
	});

	it("follows a lowered retention.days", async () => {
		await runCaptured("config", "set", "retention.days", "7");
		await runCaptured("purge");
		expect(sessions()).toEqual([]);
	});

	it("--all outside a terminal needs --yes (exit 2, nothing deleted)", async () => {
		const r = await runCaptured("purge", "--all");
		expect(r.code).toBe(2);
		expect(r.stderr).toMatch(/--yes/);
		expect(sessions()).toEqual(["new", "old"]);
	});

	it("--all asks on a terminal and keeps everything on no", async () => {
		const lines: string[] = [];
		let asked = "";
		const ok = await runPurge({
			all: true,
			tty: true,
			out: (l) => void lines.push(l),
			confirm: async (q) => {
				asked = q;
				return false;
			},
		});
		expect(ok).toBe(false);
		expect(asked).toMatch(/Delete all cc-debrief data/);
		expect(lines).toEqual(["nothing deleted"]);
		expect(sessions()).toEqual(["new", "old"]);
	});

	it("--all --yes deletes every session, raw/ and the hook log, and keeps config.json", async () => {
		await runCaptured("config", "set", "retention.days", "30");
		mkdirSync(rawDir(), { recursive: true });
		writeFileSync(join(rawDir(), "dump.json"), "{}");
		writeFileSync(hookErrorsLogPath(), "old error\n");
		const r = await runCaptured("purge", "--all", "--yes");
		expect(r.code).toBe(0);
		expect(r.stdout).toMatch(/^deleted everything: 2 sessions \(4 transcript lines, \d+\.\d MB\)\n/);
		expect(r.stdout).toContain("kept config.json and drafts/");
		expect(sessions()).toEqual([]);
		expect(existsSync(rawDir())).toBe(false);
		expect(readFileSync(hookErrorsLogPath(), "utf8")).toBe("");
		expect((await runCaptured("config", "get", "retention.days")).stdout.trim()).toBe("30");
	});

	it("after purge --all, uninit still restores settings.json byte for byte", async () => {
		const original = '{\n  "theme": "dark",\n  "hooks": {}\n}\n';
		writeFileSync(claudeSettingsPath(), original);
		const pkg = join(h.claude, "..", "pkg");
		mkdirSync(pkg, { recursive: true });
		writeFileSync(join(pkg, "hook.js"), "// hook\n");
		writeFileSync(join(pkg, "cli.js"), "// cli\n");
		await runInit({ backfill: false, packageDir: pkg, out: () => {} });
		expect(readFileSync(claudeSettingsPath(), "utf8")).not.toBe(original);
		await runPurge({ all: true, yes: true, out: () => {} });
		runUninit({ out: () => {} });
		expect(readFileSync(claudeSettingsPath(), "utf8")).toBe(original);
	});
});

import { existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	binDir,
	claudeDir,
	claudeJsonPath,
	claudeSettingsPath,
	configPath,
	dataDir,
	dbPath,
	draftsDir,
	ensureDir,
	hookErrorsLogPath,
	locksDir,
	projectsDir,
	rawDir,
} from "../../src/paths";
import { tmpHome } from "../helpers/tmp-home";

const KEYS = ["CC_DEBRIEF_HOME", "CC_DEBRIEF_DB", "CLAUDE_CONFIG_DIR"] as const;

describe("paths", () => {
	const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
	afterEach(() => {
		for (const k of KEYS) {
			if (saved[k] === undefined) delete process.env[k];
			else process.env[k] = saved[k];
		}
	});

	it("uses home-dir defaults when no override is set", () => {
		for (const k of KEYS) delete process.env[k];
		const home = homedir();
		expect(dataDir()).toBe(join(home, ".cc-debrief"));
		expect(dbPath()).toBe(join(home, ".cc-debrief", "tracker.db"));
		expect(configPath()).toBe(join(home, ".cc-debrief", "config.json"));
		expect(draftsDir()).toBe(join(home, ".cc-debrief", "drafts"));
		expect(rawDir()).toBe(join(home, ".cc-debrief", "raw"));
		expect(binDir()).toBe(join(home, ".cc-debrief", "bin"));
		expect(locksDir()).toBe(join(home, ".cc-debrief", "locks"));
		expect(hookErrorsLogPath()).toBe(join(home, ".cc-debrief", "hook-errors.log"));
		expect(claudeDir()).toBe(join(home, ".claude"));
		expect(claudeSettingsPath()).toBe(join(home, ".claude", "settings.json"));
		expect(projectsDir()).toBe(join(home, ".claude", "projects"));
		expect(claudeJsonPath()).toBe(join(home, ".claude.json"));
	});

	it("follows CC_DEBRIEF_HOME, CC_DEBRIEF_DB and CLAUDE_CONFIG_DIR, read at call time", () => {
		const base = join(homedir(), "does-not-matter");
		process.env.CC_DEBRIEF_HOME = join(base, "data");
		process.env.CC_DEBRIEF_DB = join(base, "other", "x.db");
		process.env.CLAUDE_CONFIG_DIR = join(base, "claude");
		expect(dataDir()).toBe(join(base, "data"));
		expect(dbPath()).toBe(join(base, "other", "x.db"));
		expect(configPath()).toBe(join(base, "data", "config.json"));
		expect(draftsDir()).toBe(join(base, "data", "drafts"));
		expect(rawDir()).toBe(join(base, "data", "raw"));
		expect(binDir()).toBe(join(base, "data", "bin"));
		expect(locksDir()).toBe(join(base, "data", "locks"));
		expect(hookErrorsLogPath()).toBe(join(base, "data", "hook-errors.log"));
		expect(claudeDir()).toBe(join(base, "claude"));
		expect(claudeSettingsPath()).toBe(join(base, "claude", "settings.json"));
		expect(projectsDir()).toBe(join(base, "claude", "projects"));
		expect(claudeJsonPath()).toBe(join(base, "claude", ".claude.json"));
	});

	it("dbPath defaults under an overridden data dir", () => {
		delete process.env.CC_DEBRIEF_DB;
		process.env.CC_DEBRIEF_HOME = join(homedir(), "elsewhere");
		expect(dbPath()).toBe(join(homedir(), "elsewhere", "tracker.db"));
	});
});

describe("ensureDir", () => {
	it("creates a nested missing path, mode 0700 on POSIX", () => {
		const t = tmpHome();
		try {
			const dir = join(t.home, "a", "b", "c");
			ensureDir(dir);
			expect(statSync(dir).isDirectory()).toBe(true);
			if (process.platform !== "win32") {
				expect(statSync(dir).mode & 0o777).toBe(0o700);
				expect(statSync(join(t.home, "a")).mode & 0o777).toBe(0o700);
			}
			ensureDir(dir); // idempotent
		} finally {
			t.cleanup();
		}
	});
});

describe("tmpHome", () => {
	it("sets the env keys to temp dirs and restores them on cleanup", () => {
		const before = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
		process.env.CC_DEBRIEF_DB = "sentinel-db";
		const t = tmpHome();
		expect(process.env.CC_DEBRIEF_HOME).toBe(t.home);
		expect(process.env.CLAUDE_CONFIG_DIR).toBe(t.claude);
		expect(process.env.CC_DEBRIEF_DB).toBe(join(t.home, "tracker.db"));
		expect(t.env.CC_DEBRIEF_HOME).toBe(t.home);
		expect(t.env.CLAUDE_CONFIG_DIR).toBe(t.claude);
		expect(existsSync(join(t.claude, "projects"))).toBe(true);
		expect(dataDir()).toBe(t.home);
		expect(existsSync(t.home)).toBe(false); // left for the code under test to create
		mkdirSync(t.home);
		t.cleanup();
		expect(process.env.CC_DEBRIEF_DB).toBe("sentinel-db");
		expect(process.env.CC_DEBRIEF_HOME).toBe(before.CC_DEBRIEF_HOME);
		expect(process.env.CLAUDE_CONFIG_DIR).toBe(before.CLAUDE_CONFIG_DIR);
		expect(existsSync(t.home)).toBe(false);
		expect(existsSync(t.claude)).toBe(false);
		if (before.CC_DEBRIEF_DB === undefined) delete process.env.CC_DEBRIEF_DB;
		else process.env.CC_DEBRIEF_DB = before.CC_DEBRIEF_DB;
	});
});

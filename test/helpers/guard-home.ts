// Node-project setup file: points the home dir (HOME, USERPROFILE) at a per-file sandbox, so a test that leaves
// CC_DEBRIEF_HOME or CLAUDE_CONFIG_DIR unset (or empty) never reaches the real ~/.cc-debrief or ~/.claude, and fails
// the file if anything was written to the sandbox's defaults. Tests use tmpHome() for a data dir of their own.
// It also puts a `claude` that only records and exits 97 first on PATH, so code that spawns `claude` in a test
// without fakeClaude().install() never reaches a real Claude Code (and the file fails).
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterAll } from "vitest";

const DEFAULTS = [".cc-debrief", ".claude", ".claude.json"];

const sandbox = mkdtempSync(join(tmpdir(), "ccd-guard-home-"));
const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = sandbox;
process.env.USERPROFILE = sandbox;

const blocker = mkdtempSync(join(tmpdir(), "ccd-guard-claude-"));
const blocked = join(blocker, "spawned.log");
mkdirSync(blocker, { recursive: true });
writeFileSync(join(blocker, "claude"), `#!/bin/sh\necho "$*" >> "${blocked}"\nexit 97\n`);
chmodSync(join(blocker, "claude"), 0o755);
writeFileSync(join(blocker, "claude.cmd"), `@echo %* >> "${blocked}"\r\n@exit /b 97\r\n`);
const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
const savedPath = process.env[pathKey];
process.env[pathKey] = `${blocker}${delimiter}${savedPath ?? ""}`;

afterAll(() => {
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	if (savedPath === undefined) delete process.env[pathKey];
	else process.env[pathKey] = savedPath;
	const touched = DEFAULTS.filter((name) => existsSync(join(sandbox, name)));
	const spawned = existsSync(blocked) ? readFileSync(blocked, "utf8").trim() : "";
	rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	rmSync(blocker, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	if (touched.length) {
		throw new Error(
			`a test wrote to the default home dir (${touched.join(", ")}); use tmpHome() so CC_DEBRIEF_HOME and CLAUDE_CONFIG_DIR point at a temp dir`,
		);
	}
	if (spawned) {
		throw new Error(`a test spawned the real claude (args: ${spawned}); install fakeClaude() first`);
	}
});

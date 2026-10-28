import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Every function reads process.env at call time, so tests and child processes can redirect them.

export const dataDir = (): string => process.env.CC_DEBRIEF_HOME || join(homedir(), ".cc-debrief");
export const dbPath = (): string => process.env.CC_DEBRIEF_DB || join(dataDir(), "tracker.db");
export const configPath = (): string => join(dataDir(), "config.json");
export const draftsDir = (): string => join(dataDir(), "drafts");
export const rawDir = (): string => join(dataDir(), "raw");
export const binDir = (): string => join(dataDir(), "bin");
export const locksDir = (): string => join(dataDir(), "locks");
export const hookErrorsLogPath = (): string => join(dataDir(), "hook-errors.log");
export const coachErrorsLogPath = (): string => join(dataDir(), "coach-errors.log");

export const claudeDir = (): string => process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
export const claudeSettingsPath = (): string => join(claudeDir(), "settings.json");
export const projectsDir = (): string => join(claudeDir(), "projects");
// Claude Code keeps .claude.json beside the home dir by default, inside CLAUDE_CONFIG_DIR when that is set.
export const claudeJsonPath = (): string =>
	process.env.CLAUDE_CONFIG_DIR ? join(process.env.CLAUDE_CONFIG_DIR, ".claude.json") : join(homedir(), ".claude.json");

/** mkdir -p; directories it creates get mode 0700 on POSIX (ignored on Windows). */
export function ensureDir(path: string): void {
	mkdirSync(path, { recursive: true, mode: 0o700 });
}

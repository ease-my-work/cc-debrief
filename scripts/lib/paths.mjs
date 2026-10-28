import { homedir } from "node:os";
import { join } from "node:path";

export const spikeHome = (env = process.env) => env.CC_DEBRIEF_SPIKE_HOME ?? join(homedir(), ".cc-debrief-spike");
export const rawDir = (env = process.env) => join(spikeHome(env), "raw");
export const controlPath = (env = process.env) => join(spikeHome(env), "control.json");
export const installStatePath = (env = process.env) => join(spikeHome(env), "install-state.json");

export const claudeDir = (env = process.env) => env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
export const projectsDir = (env = process.env) => join(claudeDir(env), "projects");
export const claudeSettingsPath = (env = process.env) => join(claudeDir(env), "settings.json");

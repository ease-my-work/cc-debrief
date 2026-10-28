import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const KEYS = ["CC_DEBRIEF_HOME", "CC_DEBRIEF_DB", "CLAUDE_CONFIG_DIR"] as const;

export interface TmpHome {
	/** CC_DEBRIEF_HOME; not created, so the code under test creates it (and sets its mode). */
	home: string;
	/** CLAUDE_CONFIG_DIR, created with an empty projects/. */
	claude: string;
	/** process.env with the overrides applied, for child processes. */
	env: NodeJS.ProcessEnv;
	/** Restores the env keys and removes the temp dirs. */
	cleanup(): void;
}

export function tmpHome(): TmpHome {
	const root = mkdtempSync(join(tmpdir(), "ccd-"));
	const home = join(root, "home");
	const claude = join(root, "claude");
	mkdirSync(join(claude, "projects"), { recursive: true });

	const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
	process.env.CC_DEBRIEF_HOME = home;
	process.env.CC_DEBRIEF_DB = join(home, "tracker.db");
	process.env.CLAUDE_CONFIG_DIR = claude;

	return {
		home,
		claude,
		env: { ...process.env },
		cleanup() {
			for (const k of KEYS) {
				if (saved[k] === undefined) delete process.env[k];
				else process.env[k] = saved[k];
			}
			// SQLite handles on Windows can linger briefly after close.
			rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		},
	};
}

// The hook's only output channel: one line per error in <dataDir>/hook-errors.log (never stdout / stderr).
// appendErrorLog() is shared with the coaching log (<dataDir>/coach-errors.log), same format and rotation.
import { appendFileSync, renameSync, statSync } from "node:fs";
import { dataDir, ensureDir, hookErrorsLogPath } from "../paths";

const MAX_BYTES = 1024 * 1024;

/** Appends `ISO\tlabel\tmessage` (one line) to path, rotating it to `.1` above 1 MiB. Never throws. */
export function appendErrorLog(path: string, err: unknown, label?: string): void {
	try {
		ensureDir(dataDir());
		try {
			if (statSync(path).size > MAX_BYTES) renameSync(path, `${path}.1`);
		} catch {
			// no log yet
		}
		const message = (err instanceof Error ? err.message : String(err)).replace(/\s*[\r\n]+\s*/g, " ").slice(0, 2000);
		appendFileSync(path, `${new Date().toISOString()}\t${label ?? "-"}\t${message}\n`, { mode: 0o600 });
	} catch {
		// nowhere left to report to
	}
}

/** Appends `ISO\tevent\tmessage` (one line), rotating the log to `.1` above 1 MiB. Never throws. */
export function logHookError(err: unknown, event?: string): void {
	appendErrorLog(hookErrorsLogPath(), err, event);
}

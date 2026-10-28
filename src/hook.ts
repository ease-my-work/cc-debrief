// The hook Claude Code runs for SessionStart, Stop, PermissionRequest and SessionEnd. It never writes to stdout
// or stderr, always exits 0, never runs git or reads a transcript, and spawns its worker before loading SQLite.
import { runHook } from "./hook/run";

process.exitCode = 0;
// No warning (such as node:sqlite's ExperimentalWarning) may reach stderr.
process.removeAllListeners("warning");
process.on("warning", () => {});

const STDIN_TIMEOUT_MS = 2000;

function readStdin(): Promise<string> {
	if (process.stdin.isTTY) return Promise.resolve("");
	return new Promise((resolve) => {
		const chunks: Buffer[] = [];
		const done = () => {
			clearTimeout(timer);
			process.stdin.removeAllListeners();
			process.stdin.destroy();
			resolve(Buffer.concat(chunks).toString("utf8"));
		};
		const timer = setTimeout(done, STDIN_TIMEOUT_MS);
		process.stdin.on("data", (c: Buffer) => chunks.push(c));
		process.stdin.on("end", done);
		process.stdin.on("error", done);
	});
}

try {
	await runHook(await readStdin(), process.env);
} catch {
	// runHook logs its own errors; nothing may escape
}
process.exitCode = 0;

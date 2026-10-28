import { vi } from "vitest";
import { runCli } from "../../src/program";

/** Runs the CLI in-process and returns its exit code and what it wrote to stdout and stderr. */
export async function runCaptured(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	let stdout = "";
	let stderr = "";
	const o = vi.spyOn(process.stdout, "write").mockImplementation((s) => {
		stdout += String(s);
		return true;
	});
	const e = vi.spyOn(process.stderr, "write").mockImplementation((s) => {
		stderr += String(s);
		return true;
	});
	try {
		const code = await runCli(args);
		return { code, stdout, stderr };
	} finally {
		o.mockRestore();
		e.mockRestore();
	}
}

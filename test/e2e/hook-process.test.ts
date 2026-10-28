// Runs the built dist/hook.js as Claude Code does. A copy sits next to a stub cli.js that records its argv,
// so no real worker starts. Skipped without dist/ unless REQUIRE_DIST=1.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { hookFixtures } from "../helpers/fixtures";
import { type TmpHome, tmpHome } from "../helpers/tmp-home";

const hookJs = resolve(import.meta.dirname, "../../dist/hook.js");
const suite = process.env.REQUIRE_DIST === "1" || existsSync(hookJs) ? describe : describe.skip;

// bin/ and the stub's log live outside the temp home: the detached stub may still be writing when a test's home
// is removed, so they go once, after the whole file.
const shared = mkdtempSync(join(tmpdir(), "ccd-hookproc-"));
afterAll(async () => {
	await new Promise((r) => setTimeout(r, 1000));
	rmSync(shared, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

let h: TmpHome;
let bin: string;
let argvLog: string;
let n = 0;
beforeEach(() => {
	h = tmpHome();
	const dir = join(shared, String(n++));
	bin = join(dir, "bin");
	mkdirSync(bin, { recursive: true });
	copyFileSync(hookJs, join(bin, "hook.js"));
	argvLog = join(dir, "argv.log");
	writeFileSync(
		join(bin, "cli.js"),
		`import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)) + "\\n");\n`,
	);
});
afterEach(() => h.cleanup());

const runHookProcess = (stdin: string, env: NodeJS.ProcessEnv = {}) =>
	spawnSync(process.execPath, [join(bin, "hook.js")], {
		input: stdin,
		env: { ...h.env, ...env },
		encoding: "utf8",
		timeout: 15_000,
	});

async function waitFor(path: string, ms = 10_000): Promise<string> {
	const until = Date.now() + ms;
	while (Date.now() < until) {
		if (existsSync(path)) return readFileSync(path, "utf8");
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error(`${path} did not appear`);
}

suite("dist/hook.js as a process", () => {
	it.each(hookFixtures().map((f) => [`${f.surface}/${f.name}`, f] as const))(
		"%s: exits 0 with empty stdout and stderr",
		(_name, f) => {
			const r = runHookProcess(f.raw);
			expect(r.status).toBe(0);
			expect(r.stdout).toBe("");
			expect(r.stderr).toBe("");
			const dbExists = existsSync(join(h.home, "tracker.db"));
			expect(dbExists).toBe(f.payload.hook_event_name !== "Stop"); // Stop never opens SQLite
		},
	);

	it("exits 0 silently on malformed stdin and on empty stdin", () => {
		for (const stdin of ["{ nope", ""]) {
			const r = runHookProcess(stdin);
			expect(r.status).toBe(0);
			expect(r.stdout).toBe("");
			expect(r.stderr).toBe("");
		}
	});

	it("spawns the cli.js next to it with the worker's arguments", async () => {
		const f = hookFixtures().find((x) => x.surface === "cli" && x.name === "SessionStart-startup");
		if (!f) throw new Error("fixture missing");
		expect(runHookProcess(f.raw).status).toBe(0);
		const argv = JSON.parse((await waitFor(argvLog)).trim().split("\n")[0]);
		expect(argv).toEqual(["snapshot", f.payload.session_id, "--cwd", f.payload.cwd, "--from-hook"]);
	});
});

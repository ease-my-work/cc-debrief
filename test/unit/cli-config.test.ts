import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configPath } from "../../src/paths";
import { runCli } from "../../src/program";
import { type TmpHome, tmpHome } from "../helpers/tmp-home";

let t: TmpHome;
beforeEach(() => {
	t = tmpHome();
});
afterEach(() => {
	vi.restoreAllMocks();
	t.cleanup();
});

async function run(...args: string[]) {
	let stdout = "";
	let stderr = "";
	vi.spyOn(process.stdout, "write").mockImplementation((s) => {
		stdout += String(s);
		return true;
	});
	vi.spyOn(process.stderr, "write").mockImplementation((s) => {
		stderr += String(s);
		return true;
	});
	const code = await runCli(args);
	vi.restoreAllMocks();
	return { code, stdout, stderr };
}

describe("cc-debrief config", () => {
	it("get prints the effective config as JSON", async () => {
		const r = await run("config", "get");
		expect(r.code).toBe(0);
		const cfg = JSON.parse(r.stdout);
		expect(cfg.ai.maxPerDay).toBe(50);
		expect(cfg.dashboard).toEqual({ port: 4242, pollSeconds: 15 });
	});

	it("get <key> prints one value as JSON", async () => {
		expect(await run("config", "get", "ai.maxPerDay")).toEqual({ code: 0, stdout: "50\n", stderr: "" });
		expect((await run("config", "get", "capture.redact")).stdout).toBe('["@default"]\n');
	});

	it("get of an unknown key exits 2", async () => {
		const r = await run("config", "get", "nope.key");
		expect(r.code).toBe(2);
		expect(r.stderr).toBe("error: unknown key nope.key\n");
	});

	it("set prints the new and previous value", async () => {
		const r = await run("config", "set", "retention.days", "60");
		expect(r).toEqual({ code: 0, stdout: "retention.days = 60   (was 90)\n", stderr: "" });
		expect(JSON.parse(readFileSync(configPath(), "utf8"))).toEqual({ retention: { days: 60 } });
	});

	it("set with an invalid value exits 2 with the feature 16 error and writes nothing", async () => {
		const r = await run("config", "set", "retention.days", "-1");
		expect(r.code).toBe(2);
		expect(r.stderr).toBe("error: retention.days must be an integer between 0 and 3650\n");
		expect(r.stdout).toBe("");
		expect(existsSync(configPath())).toBe(false);
	});

	it("set with an empty string unsets ai.model", async () => {
		await run("config", "set", "ai.model", "haiku");
		const r = await run("config", "set", "ai.model", "");
		expect(r).toEqual({ code: 0, stdout: "ai.model unset (Claude Code default)\n", stderr: "" });
	});

	it("set capture.permissionHook false prints the init hint and leaves settings.json alone", async () => {
		const settings = join(t.claude, "settings.json");
		writeFileSync(settings, '{ "hooks": {} }\n');
		const before = readFileSync(settings);
		const r = await run("config", "set", "capture.permissionHook", "false");
		expect(r.code).toBe(0);
		expect(r.stdout).toBe(
			"capture.permissionHook = false   (was true)\n" +
				"Permission prompts are no longer recorded. Run `cc-debrief init` to remove the hook entry as well.\n",
		);
		expect(readFileSync(settings)).toEqual(before);
	});

	it("set with a missing value is a usage error, exit 2", async () => {
		const r = await run("config", "set", "retention.days");
		expect(r.code).toBe(2);
		expect(r.stderr).toMatch(/missing required argument/);
	});

	it("--version exits 0", async () => {
		const r = await run("--version");
		expect(r.code).toBe(0);
		expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
	});
});

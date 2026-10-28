import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import pkg from "../../package.json" with { type: "json" };

const root = resolve(import.meta.dirname, "../..");
const cliPath = resolve(root, "dist/cli.js");
const hookPath = resolve(root, "dist/hook.js");

// Skipped when nothing is built yet; CI sets REQUIRE_DIST=1 so a missing build fails instead.
const suite = process.env.REQUIRE_DIST === "1" || existsSync(cliPath) ? describe : describe.skip;

const bareImport = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)["'](?:zod|commander)["']/;

suite("dist bundles", () => {
	it("cli --version prints VERSION and exits 0", () => {
		const out = execFileSync(process.execPath, [cliPath, "--version"], { encoding: "utf8" });
		expect(out.trim()).toBe(pkg.version);
	});

	it("cli starts with a node shebang", () => {
		expect(readFileSync(cliPath, "utf8").startsWith("#!/usr/bin/env node\n")).toBe(true);
	});

	it("hook.js exists", () => {
		expect(existsSync(hookPath)).toBe(true);
	});

	it("keeps hook.js small and free of zod (its size is start-up time on every hook run)", () => {
		const hook = readFileSync(hookPath, "utf8");
		expect(Buffer.byteLength(hook)).toBeLessThan(100 * 1024);
		expect(hook).not.toMatch(/ZodObject|\$ZodType/);
	});

	it("neither bundle imports zod or commander at runtime", () => {
		for (const file of [cliPath, hookPath]) {
			expect(readFileSync(file, "utf8")).not.toMatch(bareImport);
		}
	});
});

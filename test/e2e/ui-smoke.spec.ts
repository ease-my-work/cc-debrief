// Dashboard UI smoke test (Phase 2, Playwright): the built CLI serves the built UI over fixture transcripts; every
// view renders without console errors (Recap in light and dark too), a foreign Host gets 421, and dark mode uses the
// dark background token.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { copyFixtureInto, loadFixtureCases } from "../helpers/fixtures";

const root = resolve(import.meta.dirname, "../..");
let child: ChildProcess;
let base = "";
let port = 0;
let tmp = "";

test.beforeAll(async () => {
	tmp = mkdtempSync(join(tmpdir(), "ccd-e2e-"));
	const claude = join(tmp, "claude");
	mkdirSync(join(claude, "projects"), { recursive: true });
	for (const c of loadFixtureCases()) copyFixtureInto(claude, c.caseDir);
	child = spawn(process.execPath, [join(root, "dist", "cli.js"), "dashboard", "--no-open", "--port", "0"], {
		env: {
			...process.env,
			CC_DEBRIEF_HOME: join(tmp, "home"),
			CC_DEBRIEF_DB: join(tmp, "home", "tracker.db"),
			CLAUDE_CONFIG_DIR: claude,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	let out = "";
	port = await new Promise<number>((done, fail) => {
		const timer = setTimeout(() => fail(new Error(`dashboard did not start: ${out}`)), 45_000);
		child.stdout?.on("data", (d: Buffer) => {
			out += d.toString();
			const m = /127\.0\.0\.1:(\d+)/.exec(out);
			if (m) {
				clearTimeout(timer);
				done(Number(m[1]));
			}
		});
		child.stderr?.on("data", (d: Buffer) => {
			out += d.toString();
		});
		child.on("exit", (code) => fail(new Error(`dashboard exited ${code}: ${out}`)));
	});
	base = `http://127.0.0.1:${port}`;
});

test.afterAll(() => {
	child?.kill("SIGTERM");
	if (tmp) rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

/** Opens a path and fails on any console error or uncaught page error. */
async function visit(page: Page, path: string, heading: string): Promise<void> {
	const errors: string[] = [];
	page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
	page.on("pageerror", (e) => errors.push(e.message));
	page.on("response", (r) => r.status() >= 400 && errors.push(`${r.status()} ${r.url()}`));
	await page.goto(`${base}${path}`);
	await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
	await page.waitForLoadState("networkidle");
	expect(errors).toEqual([]);
}

test("every view renders without console errors", async ({ page }) => {
	await visit(page, "/?range=30d", "Overview");
	await visit(page, "/sessions?range=30d", "Sessions");
	await page.getByRole("listbox", { name: "Sessions" }).getByRole("option").first().click();
	await expect(page.getByRole("article", { name: "Session detail" })).toBeVisible();
	await expect(page.getByText(/Timeline · \d+ turns/)).toBeVisible();
	await visit(page, "/skills", "Skills & Tools");
	await visit(page, "/repos", "Repos");
	await visit(page, "/recap?range=week", "Recap");
	await expect(page.getByRole("region", { name: "Recap" })).toBeVisible();
});

test("the Phase 7 views render in light and dark", async ({ page }) => {
	for (const scheme of ["light", "dark"] as const) {
		await page.emulateMedia({ colorScheme: scheme });
		await visit(page, "/activity?range=all", "Activity");
		await expect(page.getByRole("img", { name: "Sessions per day over the last 365 days" })).toBeVisible();
		await visit(page, "/costs?range=all", "Costs");
		await visit(page, "/tasks?range=all", "Tasks & plans");
	}
});

test("the command palette opens with Ctrl-K", async ({ page }) => {
	await visit(page, "/settings", "Settings");
	await page.keyboard.press("Control+k");
	await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
	await page.keyboard.type("costs");
	await page.keyboard.press("Enter");
	await expect(page.getByRole("heading", { level: 1, name: "Costs" })).toBeVisible();
});

test("the recap view renders in dark mode too", async ({ page }) => {
	await page.emulateMedia({ colorScheme: "dark" });
	await visit(page, "/recap?range=week&groupBy=day", "Recap");
	await expect(page.getByRole("region", { name: "Recap" })).toBeVisible();
	expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe("rgb(22, 21, 18)");
});

test("loads nothing from outside the dashboard origin", async ({ page }) => {
	const foreign: string[] = [];
	page.on("request", (r) => !r.url().startsWith(base) && foreign.push(r.url()));
	await page.goto(`${base}/`);
	await page.waitForLoadState("networkidle");
	expect(foreign).toEqual([]);
});

test("rejects a foreign Host with 421", async () => {
	const status = await new Promise<number>((done, fail) => {
		const req = request({ host: "127.0.0.1", port, path: "/api/status", headers: { host: "evil.example" } }, (res) =>
			done(res.statusCode ?? 0),
		);
		req.on("error", fail);
		req.end();
	});
	expect(status).toBe(421);
});

test("follows the OS dark theme", async ({ page }) => {
	await page.emulateMedia({ colorScheme: "dark" });
	await page.goto(`${base}/`);
	await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
	expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe("rgb(22, 21, 18)");
	await page.emulateMedia({ colorScheme: "light" });
	expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe("rgb(244, 243, 238)");
});

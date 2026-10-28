import { type ChildProcess, spawn } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as context from "../../src/coach/context";
import { TIER1_VERSION } from "../../src/coach/tier1";
import { ExitCode } from "../../src/commands/common";
import {
	coachInBackground,
	type DashboardHandle,
	pollOnce,
	runDashboard,
	startPoll,
} from "../../src/commands/dashboard";
import type { Db } from "../../src/db/adapter";
import { getMeta } from "../../src/db/queries/meta";
import { stalePriceSessions } from "../../src/derive/reprice";
import { ensureDir } from "../../src/paths";
import { getTier1Progress } from "../../src/server/progress";
import type { StatusResponse } from "../../src/server/types";
import { bundleScript } from "../helpers/bundle";
import { writeTree } from "../helpers/claude-tree";
import { writeTranscript } from "../helpers/fixtures";
import { seedDb } from "../helpers/seed";
import { seedCoachSession } from "../helpers/seed-coach";
import { type TmpHome, tmpHome } from "../helpers/tmp-home";

const A = "aaaaaaaa-0000-4000-8000-0000000000a1";
const B = "bbbbbbbb-0000-4000-8000-0000000000b2";
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const prompt = (ts: string, text = "work") => ({
	type: "user",
	uuid: `p-${ts}-${text}`,
	timestamp: ts,
	cwd: "/w/none",
	entrypoint: "cli",
	message: { role: "user", content: text },
});

let h: TmpHome;
let ui: string;
let lines: string[];
let errors: string[];
const handles: DashboardHandle[] = [];
beforeEach(() => {
	h = tmpHome();
	ui = join(h.home, "..", "ui");
	mkdirSync(ui, { recursive: true });
	writeFileSync(join(ui, "index.html"), "<!doctype html><title>cc-debrief</title>");
	lines = [];
	errors = [];
});
afterEach(async () => {
	for (const d of handles.splice(0)) await d.stop();
	h.cleanup();
});

const start = async (o: Partial<Parameters<typeof runDashboard>[0]> = {}) => {
	const d = await runDashboard({
		port: 0,
		open: false,
		uiDir: ui,
		out: (l) => lines.push(l),
		err: (l) => errors.push(l),
		...o,
	});
	handles.push(d);
	return d;
};

describe("runDashboard", () => {
	it("scans, ingests and serves on a free port without opening a browser", async () => {
		writeTree(h.claude, { "skills/hello/SKILL.md": "---\nname: hello\n---\n" });
		writeTranscript(h.claude, "p", A, [prompt(ago(90))]);
		writeTranscript(h.claude, "p", B, [prompt(ago(80))]);
		const d = await start();
		expect(d.port).toBeGreaterThan(0);
		expect(d.address).toBe("127.0.0.1");
		expect(lines).toContain("scan: 1 skill, 0 MCP servers · ingest: 2 transcripts · enrich: 2 pending (no AI)");
		expect(lines).toContain(`cc-debrief dashboard on http://127.0.0.1:${d.port}  (Ctrl+C to stop)`);
		const r = await fetch(`http://127.0.0.1:${d.port}/api/status`);
		expect(r.status).toBe(200);
		expect(((await r.json()) as StatusResponse).lastIngestAt).toEqual(expect.any(String));
		const db = seedDb();
		try {
			expect(db.prepare("SELECT count(*) AS n FROM sessions").get<{ n: number }>()?.n).toBe(2);
			expect(getMeta(db, "last_scan_user")).toEqual(expect.any(String));
			expect(db.prepare("SELECT name FROM inventory").all()).toEqual([{ name: "hello" }]);
		} finally {
			db.close();
		}
		expect((await fetch(`http://127.0.0.1:${d.port}/sessions`)).status).toBe(200);
	});

	it("re-prices sessions derived with an older price table on start (Phase 7 P7)", async () => {
		writeTranscript(h.claude, "p", A, [prompt(ago(90))]);
		await (await start()).stop();
		writeFileSync(
			join(h.home, "config.json"),
			JSON.stringify({ pricing: { overrides: { opus: { input: 1, output: 1 } } } }),
		);
		const d = await start();
		await d.idle();
		const db = seedDb();
		try {
			expect(stalePriceSessions(db)).toEqual([]);
			expect(getMeta(db, "price_table_version")).toMatch(/\+[0-9a-f]{8}$/);
		} finally {
			db.close();
		}
	});

	it("rejects a foreign Host over a real socket", async () => {
		const d = await start();
		const { request } = await import("node:http");
		const status = await new Promise<number>((resolve, reject) => {
			const req = request(
				{ host: "127.0.0.1", port: d.port, path: "/api/status", headers: { host: "evil.example" } },
				(res) => resolve(res.statusCode ?? 0),
			);
			req.on("error", reject);
			req.end();
		});
		expect(status).toBe(421);
	});

	it("exits 1 with a --port hint when the port is taken", async () => {
		const blocker: Server = createServer();
		await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
		const port = (blocker.address() as { port: number }).port;
		try {
			await expect(start({ port })).rejects.toEqual(new ExitCode(1));
			expect(errors.join("\n")).toMatch(/--port/);
		} finally {
			blocker.close();
		}
	});

	it("exits 1 with the bin-copy hint when there is no UI next to the CLI", async () => {
		await expect(start({ uiDir: join(h.home, "bin", "ui") })).rejects.toEqual(new ExitCode(1));
		expect(errors.join("\n")).toContain("Run `npx cc-debrief dashboard` (the bin copy is for hooks only)");
	});

	it("answers requests while a background backfill runs, with progress in /api/status", async () => {
		for (let i = 0; i < 40; i++)
			writeTranscript(h.claude, "p", `dddddddd-0000-4000-8000-0000000000${String(i).padStart(2, "0")}`, [
				prompt(ago(100 + i)),
				prompt(ago(99 + i), "more"),
			]);
		const d = await start({ foregroundSessions: 0 });
		const s = (await (await fetch(`http://127.0.0.1:${d.port}/api/status`)).json()) as StatusResponse;
		expect(s.backfill).not.toBeNull();
		expect(s.backfill?.total).toBe(40);
		expect(s.backfill?.done).toBeLessThan(40);
		await d.idle();
	});

	it("continues a large backfill in the background, reporting progress in /api/status", async () => {
		for (let i = 0; i < 3; i++)
			writeTranscript(h.claude, "p", `cccccccc-0000-4000-8000-00000000000${i}`, [prompt(ago(60 + i))]);
		const d = await start({ foregroundSessions: 0 });
		const seen: (StatusResponse["backfill"] | undefined)[] = [];
		for (let i = 0; i < 100; i++) {
			const s = (await (await fetch(`http://127.0.0.1:${d.port}/api/status`)).json()) as StatusResponse;
			seen.push(s.backfill);
			if (s.backfill === null && seen.length > 1) break;
			await new Promise((r) => setTimeout(r, 50));
		}
		expect(seen.at(-1)).toBeNull();
		await d.idle();
		const db = seedDb();
		try {
			expect(db.prepare("SELECT count(*) AS n FROM sessions").get<{ n: number }>()?.n).toBe(3);
		} finally {
			db.close();
		}
	});
});

describe("coaching on dashboard start", () => {
	it("recomputes the digest rules after Tier 1", async () => {
		const db = seedDb();
		try {
			db.prepare("INSERT INTO repos (repo_id, root_path, name) VALUES ('r', '/nowhere', 'app')").run();
			seedCoachSession(db, "d", { retry: true, startedAt: ago(120), repoId: "r" });
			db.prepare("UPDATE sessions SET enriched_at = ?").run(ago(1));
		} finally {
			db.close();
		}
		const d = await start();
		await d.idle();
		const check = seedDb();
		try {
			// npm test failed 3 times in repo r this week
			expect(check.prepare("SELECT rule, repo_id FROM findings WHERE session_id IS NULL").all()).toEqual([
				{ rule: "tool_failure_hotspot", repo_id: "r" },
			]);
		} finally {
			check.close();
		}
	});

	it("runs Tier 1 for recent sessions in the background and clears tier1Job when done", async () => {
		const db = seedDb();
		try {
			seedCoachSession(db, "x", { retry: true, startedAt: ago(120) });
			seedCoachSession(db, "old", { retry: true, startedAt: ago(60 * 24 * 40) });
			db.prepare("UPDATE sessions SET enriched_at = ?").run(ago(1));
		} finally {
			db.close();
		}
		const d = await start();
		await d.idle();
		const s = (await (await fetch(`http://127.0.0.1:${d.port}/api/status`)).json()) as StatusResponse;
		expect(s.tier1Job).toBeNull();
		const check = seedDb();
		try {
			expect(check.prepare("SELECT session_id, rule FROM findings").all()).toEqual([
				{ session_id: "x", rule: "retry_loop" },
			]);
			expect(check.prepare("SELECT session_id, tier1_version FROM sessions ORDER BY session_id").all()).toEqual([
				{ session_id: "old", tier1_version: null },
				{ session_id: "x", tier1_version: TIER1_VERSION },
			]);
		} finally {
			check.close();
		}
		expect(errors).toEqual([]);
	});

	it("reports batch progress in tier1Job between batches", async () => {
		const db = seedDb();
		try {
			// One transaction: autocommit inserts are slow enough on the Windows CI runner to time the test out.
			db.transaction(() => {
				for (let i = 0; i < 60; i++) seedCoachSession(db, `s${i}`, { startedAt: ago(120 + i) });
			});
			const controller = new AbortController();
			// The first batch runs before the first yield.
			const p = coachInBackground(db, controller.signal);
			expect(getTier1Progress()).toEqual({ done: 50, total: 60 });
			await p;
			expect(getTier1Progress()).toBeNull();
			expect(db.prepare("SELECT count(*) AS n FROM sessions WHERE tier1_version IS NULL").get()).toEqual({ n: 0 });
		} finally {
			db.close();
		}
	});
});

describe("coachInBackground with a failing session", () => {
	it("keeps going past a batch with one failure, and stops when only failures are left (review B7)", async () => {
		const db = seedDb();
		const real = context.loadSessionContext;
		const spy = vi.spyOn(context, "loadSessionContext").mockImplementation((d, id, opts) => {
			if (id === "s0") throw new Error("bad session");
			return real(d, id, opts);
		});
		try {
			// s0 is the newest, so it is in every batch
			db.transaction(() => {
				for (let i = 0; i < 120; i++) seedCoachSession(db, `s${i}`, { startedAt: ago(120 + i) });
			});
			await coachInBackground(db, new AbortController().signal);
			expect(db.prepare("SELECT session_id FROM sessions WHERE tier1_version IS NULL").all()).toEqual([
				{ session_id: "s0" },
			]);
		} finally {
			spy.mockRestore();
			db.close();
		}
	});
});

describe("startPoll", () => {
	let db: Db;
	beforeEach(() => {
		db = seedDb();
	});
	afterEach(() => db.close());

	const lineCount = (sid: string) =>
		db.prepare("SELECT count(*) AS n FROM transcript_lines WHERE session_id = ?").get<{ n: number }>(sid)?.n ?? 0;

	it("ingests appended lines within the interval, and stop() ends it", async () => {
		const path = writeTranscript(h.claude, "p", A, [prompt(ago(10))]);
		await pollOnce(db);
		expect(lineCount(A)).toBe(1);
		const stop = startPoll(db, 1);
		try {
			appendFileSync(path, `${JSON.stringify(prompt(ago(1), "more"))}\n`);
			const t0 = Date.now();
			while (lineCount(A) < 2 && Date.now() - t0 < 2500) await new Promise((r) => setTimeout(r, 50));
			expect(lineCount(A)).toBe(2);
		} finally {
			stop();
		}
		appendFileSync(path, `${JSON.stringify(prompt(ago(0), "after stop"))}\n`);
		await new Promise((r) => setTimeout(r, 1500));
		expect(lineCount(A)).toBe(2);
	});

	it("creates no timer when pollSeconds is 0", () => {
		const timeout = vi.spyOn(globalThis, "setTimeout");
		const interval = vi.spyOn(globalThis, "setInterval");
		try {
			const stop = startPoll(db, 0);
			expect(timeout).not.toHaveBeenCalled();
			expect(interval).not.toHaveBeenCalled();
			stop();
		} finally {
			timeout.mockRestore();
			interval.mockRestore();
		}
	});

	describe("with a session lock held by another process", () => {
		let holder: string;
		let scriptHome: TmpHome;
		beforeAll(() => {
			scriptHome = tmpHome();
			ensureDir(scriptHome.home);
			holder = bundleScript(scriptHome.home, 'import "./test/helpers/hold-lock.ts";', "hold-lock.mjs");
		});
		afterAll(() => scriptHome.cleanup());

		it("skips that session without an error and ingests the others", async () => {
			writeTranscript(h.claude, "p", A, [prompt(ago(10))]);
			writeTranscript(h.claude, "p", B, [prompt(ago(9))]);
			const child: ChildProcess = spawn(process.execPath, [holder, A, "4000"], { env: h.env });
			try {
				await new Promise<void>((resolve, reject) => {
					child.stdout?.on("data", (d: Buffer) => d.toString().includes("locked") && resolve());
					child.on("exit", () => reject(new Error("holder exited")));
				});
				await expect(pollOnce(db)).resolves.toBeUndefined();
				expect(lineCount(A)).toBe(0);
				expect(lineCount(B)).toBe(1);
			} finally {
				child.kill();
			}
		}, 15_000);
	});
});

// Windows has no catchable SIGINT for a child sent a signal by another process: run where signals exist.
describe.skipIf(process.platform === "win32")("SIGINT", () => {
	it("closes the server and exits 0", async () => {
		const script = bundleScript(
			h.home.replace(/home$/, ""),
			`import { runDashboard } from "./src/commands/dashboard.ts";
			 const d = await runDashboard({ port: 0, open: false, uiDir: ${JSON.stringify(ui)} });
			 await d.done;`,
			"dash.mjs",
		);
		const child = spawn(process.execPath, [script], { env: h.env });
		let out = "";
		let errOut = "";
		child.stderr?.on("data", (d: Buffer) => {
			errOut += d.toString();
		});
		await new Promise<void>((resolve, reject) => {
			child.stdout?.on("data", (d: Buffer) => {
				out += d.toString();
				if (out.includes("Ctrl+C to stop")) resolve();
			});
			child.on("exit", () => reject(new Error(`exited early: ${out}${errOut}`)));
		});
		const port = Number(/127\.0\.0\.1:(\d+)/.exec(out)?.[1]);
		const code = await new Promise<number | null>((resolve) => {
			child.removeAllListeners("exit");
			child.on("exit", (c) => resolve(c));
			child.kill("SIGINT");
		});
		expect(code).toBe(0);
		await expect(fetch(`http://127.0.0.1:${port}/api/status`)).rejects.toThrow();
	}, 30_000);
});

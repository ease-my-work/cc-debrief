import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withSessionLock } from "../../src/locks";
import { ensureDir, locksDir } from "../../src/paths";
import { bundleScript } from "../helpers/bundle";
import { type TmpHome, tmpHome } from "../helpers/tmp-home";

const SID = "0b7c3f5e-1111-4222-8333-944455556666";

let holderScript: string;
let scriptHome: TmpHome;
beforeAll(() => {
	scriptHome = tmpHome();
	ensureDir(scriptHome.home);
	holderScript = bundleScript(scriptHome.home, 'import "./test/helpers/hold-lock.ts";', "hold-lock.mjs");
});
afterAll(() => scriptHome.cleanup());

let t: TmpHome;
const children: ChildProcess[] = [];
beforeEach(() => {
	t = tmpHome();
});
afterEach(() => {
	for (const c of children.splice(0)) c.kill();
	t.cleanup();
});

/** Starts a child that holds SID's lock for holdMs; resolves once it has the lock. */
function holdLock(holdMs: number): Promise<ChildProcess> {
	const child = spawn(process.execPath, [holderScript, SID, String(holdMs)], { env: t.env });
	children.push(child);
	return new Promise((resolve, reject) => {
		child.stdout?.on("data", (d: Buffer) => {
			if (d.toString().includes("locked")) resolve(child);
		});
		child.on("exit", (code) => reject(new Error(`holder exited ${code} before locking`)));
	});
}

const lockFile = () => join(locksDir(), `${SID}.lock`);

function writeLock(pid: number, startedAt: Date) {
	ensureDir(locksDir());
	writeFileSync(lockFile(), JSON.stringify({ pid, startedAt: startedAt.toISOString() }));
}

describe("withSessionLock", () => {
	it("runs fn on a free lock, returns its result and removes the file", async () => {
		let during = false;
		const r = await withSessionLock(SID, { waitMs: 0 }, async () => {
			during = existsSync(lockFile());
			return 42;
		});
		expect(r).toBe(42);
		expect(during).toBe(true);
		expect(existsSync(lockFile())).toBe(false);
	});

	it("returns busy at once with waitMs 0 while another process holds it", async () => {
		await holdLock(10_000);
		let called = false;
		const start = Date.now();
		const r = await withSessionLock(SID, { waitMs: 0 }, async () => {
			called = true;
		});
		expect(r).toBe("busy");
		expect(Date.now() - start).toBeLessThan(100);
		expect(called).toBe(false);
	});

	it("waits for a short hold to end, then runs fn", async () => {
		await holdLock(300);
		const r = await withSessionLock(SID, { waitMs: 5000 }, async () => "ran");
		expect(r).toBe("ran");
	});

	it("gives up with busy after waitMs when the hold is longer", async () => {
		await holdLock(6000);
		const start = Date.now();
		const r = await withSessionLock(SID, { waitMs: 5000 }, async () => "ran");
		const waited = Date.now() - start;
		expect(r).toBe("busy");
		expect(waited).toBeGreaterThanOrEqual(4900);
		expect(waited).toBeLessThan(5900);
	});

	it("takes over a lock whose pid is dead", async () => {
		const dead = spawnSync(process.execPath, ["-e", ""]).pid as number;
		writeLock(dead, new Date());
		expect(await withSessionLock(SID, { waitMs: 0 }, async () => "ran")).toBe("ran");
		expect(existsSync(lockFile())).toBe(false);
	});

	it("takes over a lock older than 10 minutes even with a live pid", async () => {
		writeLock(process.ppid, new Date(Date.now() - 11 * 60_000));
		expect(await withSessionLock(SID, { waitMs: 0 }, async () => "ran")).toBe("ran");
	});

	it("does not take over a recent lock with a live pid", async () => {
		writeLock(process.ppid, new Date());
		expect(await withSessionLock(SID, { waitMs: 0 }, async () => "ran")).toBe("busy");
		expect(existsSync(lockFile())).toBe(true);
	});

	it("releases the lock when fn throws and propagates the error", async () => {
		await expect(
			withSessionLock(SID, { waitMs: 0 }, async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		expect(existsSync(lockFile())).toBe(false);
		expect(await withSessionLock(SID, { waitMs: 0 }, async () => "again")).toBe("again");
	});

	it.each(["../x", "", "a/b", "a.b", "x".repeat(101)])("rejects session id %j without touching the fs", async (id) => {
		await expect(withSessionLock(id, { waitMs: 0 }, async () => "ran")).rejects.toThrow(/invalid session id/);
		expect(existsSync(locksDir()) ? readdirSync(locksDir()) : []).toEqual([]);
	});
});

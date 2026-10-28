import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setConfigValue } from "../../src/config";
import type { Db } from "../../src/db/adapter";
import { logHookError } from "../../src/hook/errors";
import { HookPayload } from "../../src/hook/payload";
import { runHook } from "../../src/hook/run";
import { ensureDir, hookErrorsLogPath, rawDir } from "../../src/paths";
import { hookFixtures } from "../helpers/fixtures";
import { seedDb } from "../helpers/seed";
import { type TmpHome, tmpHome } from "../helpers/tmp-home";

const SID = "ff13b0ac-642e-45f9-982e-701c122e54ec";
let h: TmpHome;
let db: Db;
let spawned: string[][];
const deps = () => ({
	spawn: (args: string[]) => void spawned.push(args),
	now: () => new Date("2026-09-30T10:00:00.123Z"),
});
beforeEach(() => {
	h = tmpHome();
	db = seedDb();
	spawned = [];
});
afterEach(() => {
	db.close();
	h.cleanup();
});

type Row = Record<string, unknown>;
const events = () => db.prepare("SELECT session_id, event, ts, payload FROM events ORDER BY id").all<Row>();
const logLines = () =>
	existsSync(hookErrorsLogPath()) ? readFileSync(hookErrorsLogPath(), "utf8").trim().split("\n") : [];
const fixture = (surface: string, name: string) => {
	const f = hookFixtures().find((x) => x.surface === surface && x.name === name);
	if (!f) throw new Error(`no fixture ${surface}/${name}`);
	return f;
};

describe("runHook", () => {
	it.each([
		["SessionStart-startup", 1, "snapshot"],
		["PermissionRequest", 1, null],
		["SessionEnd-clear", 1, "enrich"],
		["Stop", 0, "ingest"],
	])("%s inserts %i row(s) and spawns %s", async (name, rows, worker) => {
		const f = fixture("cli", name);
		await runHook(f.raw, {}, db, deps());
		expect(events()).toHaveLength(rows);
		expect(spawned.map((a) => a[0])).toEqual(worker ? [worker] : []);
		if (rows) {
			expect(events()[0]).toMatchObject({
				session_id: f.payload.session_id,
				event: f.payload.hook_event_name,
				ts: "2026-09-30T10:00:00.123Z",
			});
		}
		expect(logLines()).toEqual([]);
	});

	it("stores a redacted copy of the payload", async () => {
		const payload = {
			session_id: SID,
			hook_event_name: "PermissionRequest",
			tool_name: "Bash",
			tool_input: { command: `curl -H "Authorization: Bearer ${"t".repeat(30)}" https://api.example.com` },
		};
		await runHook(JSON.stringify(payload), {}, db, deps());
		const stored = JSON.parse(events()[0].payload as string);
		expect(stored.tool_input.command).toBe('curl -H "Authorization: Bearer [REDACTED]" https://api.example.com');
		expect(stored.tool_name).toBe("Bash");
	});

	it("inserts no PermissionRequest row once capture.permissionHook is false", async () => {
		setConfigValue("capture.permissionHook", "false");
		await runHook(fixture("cli", "PermissionRequest").raw, {}, db, deps());
		expect(events()).toEqual([]);
		expect(spawned).toEqual([]);
	});

	it.each([
		["malformed stdin", "{ not json"],
		["a missing session_id", JSON.stringify({ hook_event_name: "SessionEnd" })],
	])("writes one log line and nothing else for %s", async (_name, stdin) => {
		await expect(runHook(stdin, {}, db, deps())).resolves.toBeUndefined();
		expect(events()).toEqual([]);
		expect(spawned).toEqual([]);
		expect(logLines()).toHaveLength(1);
		expect(logLines()[0]).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z\t/);
	});

	it("does nothing for an internal session", async () => {
		await runHook(fixture("cli", "SessionEnd-clear").raw, { CC_DEBRIEF_INTERNAL: "1" }, db, deps());
		expect(events()).toEqual([]);
		expect(spawned).toEqual([]);
		expect(logLines()).toEqual([]);
	});

	it("logs instead of throwing when the insert fails", async () => {
		db.exec("DROP TABLE events");
		await expect(runHook(fixture("cli", "SessionEnd-clear").raw, {}, db, deps())).resolves.toBeUndefined();
		expect(spawned).toHaveLength(1); // the spawn happened first
		expect(logLines()[0]).toContain("\tSessionEnd\t");
	});

	it("opens the DB itself when none is given", async () => {
		db.close();
		await runHook(fixture("cli", "SessionEnd-clear").raw, {}, undefined, deps());
		db = seedDb();
		expect(events()).toHaveLength(1);
	});

	it("dumps raw stdin when CC_DEBRIEF_RAW_DUMP=1", async () => {
		const f = fixture("cli", "Stop");
		await runHook(f.raw, { CC_DEBRIEF_RAW_DUMP: "1" }, db, deps());
		const { readdirSync } = await import("node:fs");
		const files = readdirSync(rawDir());
		expect(files).toHaveLength(1);
		expect(readFileSync(`${rawDir()}/${files[0]}`, "utf8")).toBe(f.raw);
	});
});

describe("HookPayload", () => {
	it("parses all 20 Phase 0 payloads and passes unknown fields through", () => {
		const all = hookFixtures();
		expect(all).toHaveLength(20);
		for (const f of all) {
			const parsed = HookPayload.parse(f.payload);
			expect(parsed, `${f.surface}/${f.name}`).toEqual(f.payload);
			if (f.name.startsWith("SessionEnd-")) expect(parsed.reason).toBe(f.name.slice("SessionEnd-".length));
			if (f.name.startsWith("SessionStart-")) expect(parsed.source).toBe(f.name.slice("SessionStart-".length));
		}
	});

	it("requires session_id and hook_event_name", () => {
		expect(HookPayload.safeParse({ hook_event_name: "Stop" }).success).toBe(false);
		expect(HookPayload.safeParse({ session_id: SID }).success).toBe(false);
		expect(HookPayload.safeParse({ session_id: SID, hook_event_name: "Stop", source: "fork" }).success).toBe(true);
	});
});

describe("logHookError", () => {
	it("writes one line per error and rotates to .1 above 1 MiB", () => {
		ensureDir(h.home);
		writeFileSync(hookErrorsLogPath(), "x".repeat(1024 * 1024 + 10));
		logHookError(new Error("boom\nsecond line"), "Stop");
		expect(existsSync(`${hookErrorsLogPath()}.1`)).toBe(true);
		expect(statSync(hookErrorsLogPath()).size).toBeLessThan(200);
		expect(logLines()).toEqual([expect.stringMatching(/\tStop\tboom second line$/)]);
	});

	it("never throws, even when the data dir cannot be written", () => {
		// A data dir under a regular file can't be created anywhere. (Not "\0...": Windows truncates an env value at the
		// NUL, so CC_DEBRIEF_HOME reads as "" and the real ~/.cc-debrief gets written.)
		ensureDir(h.home);
		const file = join(h.home, "not-a-dir");
		writeFileSync(file, "");
		process.env.CC_DEBRIEF_HOME = join(file, "data");
		try {
			expect(() => logHookError(new Error("x"))).not.toThrow();
		} finally {
			process.env.CC_DEBRIEF_HOME = h.home;
		}
	});
});

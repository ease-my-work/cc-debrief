import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ingestFromHook, replyIngested } from "../../src/commands/ingest";
import type { Db } from "../../src/db/adapter";
import { expectHash } from "../../src/hook/run";
import { withSessionLock } from "../../src/locks";
import { hookErrorsLogPath } from "../../src/paths";
import { writeTranscript } from "../helpers/fixtures";
import { runCaptured } from "../helpers/run-cli";
import { seedDb } from "../helpers/seed";
import { type TmpHome, tmpHome } from "../helpers/tmp-home";

const SID = "33333333-3333-4333-8333-333333333333";
const REPLY = "Done.  The typo in   src/hello.ts is fixed\nand the tests pass.";
const now = () => new Date().toISOString();
const prompt = (text: string, uuid: string) => ({
	type: "user",
	uuid,
	timestamp: now(),
	sessionId: SID,
	cwd: "/work/app",
	message: { role: "user", content: text },
});
const reply = (text: string, uuid: string) => ({
	type: "assistant",
	uuid,
	timestamp: now(),
	sessionId: SID,
	cwd: "/work/app",
	message: {
		id: `msg-${uuid}`,
		role: "assistant",
		model: "claude-opus-5-5",
		content: [{ type: "text", text }],
		usage: { input_tokens: 10, output_tokens: 5 },
	},
});

let h: TmpHome;
let db: Db;
let derived: string[];
let slept: number[];
const deps = () => ({
	derive: (_db: Db, id: string) => void derived.push(id),
	sleep: (ms: number) => {
		slept.push(ms);
		return new Promise<void>((r) => setTimeout(r, ms));
	},
});
beforeEach(() => {
	h = tmpHome();
	db = seedDb();
	derived = [];
	slept = [];
});
afterEach(() => {
	db.close();
	h.cleanup();
});

const storedLines = () => (db.prepare("SELECT count(*) AS n FROM transcript_lines").get() as { n: number }).n;
const logText = () => (existsSync(hookErrorsLogPath()) ? readFileSync(hookErrorsLogPath(), "utf8") : "");

describe("replyIngested", () => {
	it("matches a stored assistant text by its expect hash, whitespace collapsed", async () => {
		writeTranscript(h.claude, "proj", SID, [prompt("fix it", "u1"), reply(REPLY, "a1")]);
		await ingestFromHook(db, SID, { delayMs: 0 }, deps());
		expect(replyIngested(db, SID, expectHash(REPLY))).toBe(true);
		expect(replyIngested(db, SID, expectHash(`${REPLY} more`))).toBe(false);
		expect(replyIngested(db, "44444444-4444-4444-8444-444444444444", expectHash(REPLY))).toBe(false);
	});

	it("matches a reply split over several text blocks and lines", async () => {
		const long = "x".repeat(150);
		writeTranscript(h.claude, "proj", SID, [
			prompt("go", "u1"),
			reply(long, "a1"),
			(() => {
				const second = reply("second part of the answer", "a2");
				return { ...second, message: { ...second.message, id: "msg-a1" } };
			})(),
		]);
		await ingestFromHook(db, SID, { delayMs: 0 }, deps());
		expect(replyIngested(db, SID, expectHash(`${long}\n\nsecond part of the answer`))).toBe(true);
	});
});

describe("ingestFromHook", () => {
	it("reads once and derives once when the reply is already in the file", async () => {
		writeTranscript(h.claude, "proj", SID, [prompt("fix it", "u1"), reply(REPLY, "a1")]);
		const r = await ingestFromHook(db, SID, { expect: expectHash(REPLY), delayMs: 20 }, deps());
		expect(r).toMatchObject({ lines: 2 });
		expect(slept).toEqual([20]);
		expect(derived).toEqual([SID]);
	});

	it("re-reads once when the reply lands after the first read, then derives once", async () => {
		const path = writeTranscript(h.claude, "proj", SID, [prompt("fix it", "u1")]);
		const start = Date.now();
		setTimeout(() => appendFileSync(path, `${JSON.stringify(reply(REPLY, "a1"))}\n`), 700);
		const r = await ingestFromHook(db, SID, { expect: expectHash(REPLY) }, deps());
		expect(Date.now() - start).toBeGreaterThanOrEqual(900);
		expect(slept).toEqual([500, 500]);
		expect(r).toMatchObject({ lines: 2 });
		expect(replyIngested(db, SID, expectHash(REPLY))).toBe(true);
		expect(derived).toEqual([SID]);
	});

	it("gives up after the second read when the reply never comes, without logging", async () => {
		writeTranscript(h.claude, "proj", SID, [prompt("fix it", "u1")]);
		const r = await ingestFromHook(db, SID, { expect: expectHash(REPLY), delayMs: 30 }, deps());
		expect(slept).toEqual([30, 30]);
		expect(r).toMatchObject({ lines: 1 });
		expect(derived).toEqual([SID]);
		expect(logText()).toBe("");
	});

	it("does not derive when neither read found anything new", async () => {
		writeTranscript(h.claude, "proj", SID, [prompt("fix it", "u1")]);
		await ingestFromHook(db, SID, { delayMs: 0 }, deps());
		derived = [];
		await ingestFromHook(db, SID, { expect: expectHash(REPLY), delayMs: 0 }, deps());
		expect(derived).toEqual([]);
	});

	it("a derive that throws leaves the files pending, so the next run derives the session (review A1)", async () => {
		writeTranscript(h.claude, "proj", SID, [prompt("fix it", "u1"), reply(REPLY, "a1")]);
		const failing = {
			...deps(),
			derive: () =>
				void (() => {
					throw new Error("SQLITE_BUSY");
				})(),
		};
		await expect(ingestFromHook(db, SID, { delayMs: 0 }, failing)).rejects.toThrow("SQLITE_BUSY");
		expect(db.prepare("SELECT size, last_ingested_at FROM transcripts").get()).toEqual({
			size: -1,
			last_ingested_at: null,
		});
		await ingestFromHook(db, SID, { delayMs: 0 }, deps());
		expect(derived).toEqual([SID]);
	});

	it("sets last_ingested_at (the UI's refresh signal) only after the derive (review A2)", async () => {
		writeTranscript(h.claude, "proj", SID, [prompt("fix it", "u1")]);
		let atDerive: unknown = "unset";
		const watching = {
			...deps(),
			derive: (d: Db) => {
				atDerive = d.prepare("SELECT last_ingested_at AS t FROM transcripts").get<{ t: string | null }>()?.t;
			},
		};
		await ingestFromHook(db, SID, { delayMs: 0 }, watching);
		expect(atDerive).toBeNull();
		expect(db.prepare("SELECT last_ingested_at AS t FROM transcripts").get<{ t: string | null }>()?.t).not.toBeNull();
	});

	it("returns busy without reading while the session lock is held", async () => {
		writeTranscript(h.claude, "proj", SID, [prompt("fix it", "u1")]);
		const r = await withSessionLock(SID, { waitMs: 0 }, () => ingestFromHook(db, SID, { delayMs: 0 }, deps()));
		expect(r).toBe("busy");
		expect(storedLines()).toBe(0);
	});
});

describe("cc-debrief ingest", () => {
	it("--from-hook exits 0 in under a second with no output while the lock is held", async () => {
		writeTranscript(h.claude, "proj", SID, [prompt("fix it", "u1")]);
		const start = Date.now();
		const r = await withSessionLock(SID, { waitMs: 0 }, () => runCaptured("ingest", SID, "--from-hook"));
		expect(Date.now() - start).toBeLessThan(1000);
		expect(r).toEqual({ code: 0, stdout: "", stderr: "" });
		expect(storedLines()).toBe(0);
	});

	it("--from-hook logs an error to the hook log and still exits 0", async () => {
		const r = await runCaptured("ingest", "../bad id", "--from-hook");
		expect(r).toEqual({ code: 0, stdout: "", stderr: "" });
		expect(logText()).toMatch(/\tingest\t/);
	});

	it("prints what it ingested", async () => {
		writeTranscript(h.claude, "proj", SID, [prompt("fix it", "u1"), reply(REPLY, "a1")]);
		const r = await runCaptured("ingest");
		expect(r.code).toBe(0);
		expect(r.stdout).toBe("ingested 1 transcript (1 session) · 2 lines · 0 parse errors\n");
		expect((await runCaptured("ingest", SID)).stdout).toBe(
			"ingested 0 transcripts (0 sessions) · 0 lines · 0 parse errors\n",
		);
	});

	it("rejects a bad --since date with exit 2", async () => {
		const r = await runCaptured("ingest", "--since", "last tuesday");
		expect(r.code).toBe(2);
		expect(r.stderr).toContain("--since");
	});
});

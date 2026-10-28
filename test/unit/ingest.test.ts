import { appendFileSync, existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Config, loadConfig, setConfigValue } from "../../src/config";
import type { Db } from "../../src/db/adapter";
import { setMeta } from "../../src/db/queries/meta";
import { listTranscripts } from "../../src/ingest/files";
import {
	deriveSessions,
	ingestFile,
	ingestPending,
	ingestPendingLocked,
	ingestSession,
	pendingGroups,
} from "../../src/ingest/ingest";
import { decodePayload } from "../../src/ingest/line";
import { withSessionLock } from "../../src/locks";
import { locksDir } from "../../src/paths";
import { writeTranscript } from "../helpers/fixtures";
import { seedDb } from "../helpers/seed";
import { type TmpHome, tmpHome } from "../helpers/tmp-home";

const SID = "11111111-1111-1111-1111-111111111111";
const SID2 = "22222222-2222-2222-2222-222222222222";
const u = (text: string, uuid: string, ts = new Date().toISOString()) => ({
	type: "user",
	uuid,
	timestamp: ts,
	sessionId: SID,
	message: { role: "user", content: text },
});
const jsonl = (...lines: object[]) => lines.map((l) => `${JSON.stringify(l)}\n`).join("");
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();

let h: TmpHome;
let db: Db;
let derived: string[];
let deps: { derive: (db: Db, id: string) => void };
beforeEach(() => {
	h = tmpHome();
	db = seedDb();
	derived = [];
	deps = { derive: (_db, id) => void derived.push(id) };
});
afterEach(() => {
	db.close();
	h.cleanup();
});

const main = () => listTranscripts().filter((f) => f.agentId === null)[0];
const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
const transcriptRow = () => db.prepare("SELECT * FROM transcripts").get() as Record<string, unknown>;

describe("ingestFile", () => {
	it("reads only new complete lines on each call", () => {
		const p = writeTranscript(h.claude, "proj", SID, [u("one", "a"), u("two", "b")]);
		expect(ingestFile(db, main(), deps).lines).toBe(2);
		appendFileSync(p, `${JSON.stringify(u("three", "c"))}\n{"type":"user","uuid":"d"`); // + partial line
		expect(ingestFile(db, main(), deps).lines).toBe(1);
		appendFileSync(p, ',"message":{"content":"four"}}\n');
		expect(ingestFile(db, main(), deps).lines).toBe(1);
		const rows = db.prepare("SELECT line_no, uuid FROM transcript_lines ORDER BY line_no").all();
		expect(rows).toEqual([
			{ line_no: 0, uuid: "a" },
			{ line_no: 1, uuid: "b" },
			{ line_no: 2, uuid: "c" },
			{ line_no: 3, uuid: "d" },
		]);
		expect(derived).toEqual([SID, SID, SID]);
	});

	it("records offsets, counts and identity in the transcripts row", () => {
		const p = writeTranscript(h.claude, "proj", SID, [u("one", "a"), u("two", "b")]);
		const f = main();
		const r = ingestFile(db, f, deps);
		expect(r).toEqual({ files: 1, lines: 2, parseErrors: 0, sessions: [SID] });
		expect(transcriptRow()).toMatchObject({
			path: p,
			session_id: SID,
			agent_id: null,
			size: f.size,
			mtime_ms: f.mtimeMs,
			bytes_ingested: f.size,
			lines: 2,
			first_line_uuid: "a",
			internal: 0,
			missing_since: null,
		});
		expect(transcriptRow().first_ingested_at).toEqual(expect.any(String));
	});

	it("skips an unchanged file without reading it", () => {
		writeTranscript(h.claude, "proj", SID, [u("one", "a")]);
		ingestFile(db, main(), deps);
		expect(ingestFile(db, main(), deps)).toEqual({ files: 0, lines: 0, parseErrors: 0, sessions: [] });
		expect(derived).toEqual([SID]);
	});

	it("re-reads a rewritten file from zero", () => {
		const p = writeTranscript(h.claude, "proj", SID, [u("one", "a"), u("two", "b")]);
		ingestFile(db, main(), deps);
		writeFileSync(p, `${JSON.stringify(u("new", "z"))}\n`);
		ingestFile(db, main(), deps);
		expect(db.prepare("SELECT uuid, line_no FROM transcript_lines").all()).toEqual([{ uuid: "z", line_no: 0 }]);
	});

	it("re-reads from zero when the first line changed but the file did not shrink", () => {
		const p = writeTranscript(h.claude, "proj", SID, [u("one", "a")]);
		ingestFile(db, main(), deps);
		writeFileSync(p, jsonl(u("uno", "x"), u("dos", "y"), u("tres", "w")));
		ingestFile(db, main(), deps);
		expect(db.prepare("SELECT uuid FROM transcript_lines ORDER BY line_no").all()).toEqual([
			{ uuid: "x" },
			{ uuid: "y" },
			{ uuid: "w" },
		]);
	});

	it("marks a sentinel transcript internal and stores nothing", () => {
		writeTranscript(h.claude, "proj", SID, [u("[cc-debrief:summary]\nsummarize", "a")]);
		ingestFile(db, main(), deps);
		expect(db.prepare("SELECT internal, bytes_ingested FROM transcripts").get()).toEqual({
			internal: 1,
			bytes_ingested: main().size,
		});
		expect(count("SELECT count(*) n FROM transcript_lines")).toBe(0);
		expect(derived).toEqual([]);
		appendFileSync(main().path, jsonl(u("more", "b")));
		expect(ingestFile(db, main(), deps).files).toBe(0); // internal files are never read again
	});

	it("marks a transcript internal when its id is a known internal call, sentinel or not", () => {
		db.prepare("INSERT INTO self_usage (feature, session_id, ts) VALUES ('summary', ?, ?)").run(SID, daysAgo(0));
		writeTranscript(h.claude, "proj", SID, [u("one", "a"), u("two", "b")]);
		ingestFile(db, main(), deps);
		expect(transcriptRow().internal).toBe(1);
		expect(count("SELECT count(*) n FROM transcript_lines")).toBe(0);
		expect(derived).toEqual([]);
	});

	it("marks a transcript internal when its id is in ai_calls", () => {
		db.prepare("INSERT INTO ai_calls (feature, session_id, ts) VALUES ('review', ?, ?)").run(SID, daysAgo(0));
		writeTranscript(h.claude, "proj", SID, [u("one", "a")]);
		ingestFile(db, main(), deps);
		expect(transcriptRow().internal).toBe(1);
		expect(count("SELECT count(*) n FROM transcript_lines")).toBe(0);
	});

	it("marks a fork transcript internal when the sentinel is only in its last prompt", () => {
		writeTranscript(h.claude, "proj", SID, [
			u("one", "a"),
			u("two", "b"),
			{ ...u("", "c"), message: { role: "user", content: [{ type: "text", text: "[cc-debrief:review]\nreview it" }] } },
		]);
		ingestFile(db, main(), deps);
		expect(transcriptRow().internal).toBe(1);
		expect(count("SELECT count(*) n FROM transcript_lines")).toBe(0);
	});

	it("does not treat the sentinel inside a tool result or assistant text as a prompt", () => {
		writeTranscript(h.claude, "proj", SID, [
			u("one", "a"),
			{ type: "assistant", uuid: "b", message: { content: [{ type: "text", text: "[cc-debrief:x] is a marker" }] } },
			{ type: "user", uuid: "c", message: { content: [{ type: "tool_result", content: "[cc-debrief:x]" }] } },
		]);
		ingestFile(db, main(), deps);
		expect(transcriptRow().internal).toBe(0);
		expect(count("SELECT count(*) n FROM transcript_lines")).toBe(3);
	});

	it("drops a file's lines when a later chunk brings the sentinel", () => {
		const p = writeTranscript(h.claude, "proj", SID, [u("one", "a")]);
		ingestFile(db, main(), deps);
		appendFileSync(p, jsonl(u("[cc-debrief:review]\nreview", "b")));
		const r = ingestFile(db, main(), deps);
		expect(transcriptRow().internal).toBe(1);
		expect(count("SELECT count(*) n FROM transcript_lines")).toBe(0);
		expect(r.sessions).toEqual([SID]);
		expect(derived).toEqual([SID, SID]);
	});

	it("skips files older than the retention cutoff on first sight", () => {
		writeTranscript(h.claude, "proj", SID, [u("old", "a", daysAgo(100)), { type: "ai-title", aiTitle: "t" }]);
		expect(ingestFile(db, main(), deps).files).toBe(0);
		expect(count("SELECT count(*) n FROM transcripts")).toBe(0);
		const keepAll: Config = { ...loadConfig(), retention: { days: 0 } };
		expect(ingestFile(db, main(), { ...deps, config: keepAll }).lines).toBe(2);
	});

	it("keeps ingesting a known file even when its lines are past the cutoff", () => {
		const p = writeTranscript(h.claude, "proj", SID, [u("recent", "a")]);
		ingestFile(db, main(), deps);
		appendFileSync(p, jsonl(u("odd old timestamp", "b", daysAgo(200))));
		expect(ingestFile(db, main(), deps).lines).toBe(1);
	});

	it("honours meta.ingest_not_before", () => {
		const p = writeTranscript(h.claude, "proj", SID, [u("one", "a")]);
		const old = new Date(Date.now() - 3600_000);
		utimesSync(p, old, old);
		setMeta(db, "ingest_not_before", new Date(Date.now() - 60_000).toISOString());
		expect(ingestFile(db, main(), deps).files).toBe(0);
		setMeta(db, "ingest_not_before", new Date(Date.now() - 7200_000).toISOString());
		expect(ingestFile(db, main(), deps).files).toBe(1);
	});

	it("honours purged_at", () => {
		const p = writeTranscript(h.claude, "proj", SID, [u("one", "a")]);
		ingestFile(db, main(), deps);
		db.prepare("DELETE FROM transcript_lines").run();
		db.prepare("UPDATE transcripts SET purged_at = '2026-01-01T00:00:00.000Z'").run();
		appendFileSync(p, jsonl(u("two", "b")));
		expect(ingestFile(db, main(), deps).files).toBe(0);
		expect(count("SELECT count(*) n FROM transcript_lines")).toBe(0);
	});

	it("redacts and caps before insert, and drops file-history-snapshot lines", () => {
		writeTranscript(h.claude, "proj", SID, [
			{ type: "file-history-snapshot", snapshot: {} },
			u("my password=hunter22 please", "a"),
			u("x".repeat(5000), "b"),
		]);
		const small: Config = { ...loadConfig(), capture: { ...loadConfig().capture, maxFieldBytes: 1024 } };
		const r = ingestFile(db, main(), { ...deps, config: small });
		expect(r.lines).toBe(3);
		const rows = db.prepare("SELECT line_no, payload FROM transcript_lines ORDER BY line_no").all<{
			line_no: number;
			payload: Uint8Array;
		}>();
		expect(rows.map((x) => x.line_no)).toEqual([1, 2]);
		const [first, second] = rows.map((x) => decodePayload(x.payload) as { message: { content: string } });
		expect(first.message.content).toBe("my password=[REDACTED] please");
		expect(Buffer.byteLength(second.message.content)).toBeLessThanOrEqual(1024);
		expect(second.message.content).toMatch(/…\[truncated \d+ bytes\]$/);
		expect(first).not.toHaveProperty("sessionId");
	});

	it("stores a prompt with a secret redacted in both transcript_lines and turns", () => {
		const key = `ghp_${"Z".repeat(36)}`;
		writeTranscript(h.claude, "proj", SID, [u(`deploy with token ${key} now`, "a")]);
		ingestPending(db); // the real deriveSession
		const { payload } = db.prepare("SELECT payload FROM transcript_lines").get() as { payload: Uint8Array };
		expect(JSON.stringify(decodePayload(payload))).not.toContain("ghp_");
		const turn = db.prepare("SELECT user_text FROM turns WHERE session_id = ?").get(SID) as { user_text: string };
		expect(turn.user_text).toBe("deploy with token [REDACTED] now");
	});

	it("applies @default and a custom pattern from config.json together", () => {
		setConfigValue("capture.redact", JSON.stringify(["@default", "/ACME-[0-9A-F]{8}/g"]));
		const key = `ghp_${"Z".repeat(36)}`;
		writeTranscript(h.claude, "proj", SID, [u(`token ${key} and ticket ACME-0F3A91C2`, "a")]);
		ingestPending(db);
		const turn = db.prepare("SELECT user_text FROM turns WHERE session_id = ?").get(SID) as { user_text: string };
		expect(turn.user_text).toBe("token [REDACTED] and ticket [REDACTED]");
	});

	it("redacts before slimming: a key straddling the 8 KB tool-result cut leaves no fragment", () => {
		const key = `sk-ant-api03-${"K".repeat(40)}`;
		const content = `${"a".repeat(8150)} ${key} ${"b".repeat(3000)}`; // slimLine cuts near byte 8167
		writeTranscript(h.claude, "proj", SID, [
			{ type: "user", uuid: "a", message: { content: [{ type: "tool_result", tool_use_id: "t", content }] } },
		]);
		ingestFile(db, main(), deps);
		const { payload } = db.prepare("SELECT payload FROM transcript_lines").get() as { payload: Uint8Array };
		const text = JSON.stringify(decodePayload(payload));
		expect(text).toContain("[REDACTED]");
		expect(text).not.toContain("sk-ant-");
		expect(text).not.toContain("KKKK");
	});

	it("stores payloads as BLOBs and the path once per file", () => {
		writeTranscript(h.claude, "proj", SID, [u("one", "a")]);
		ingestFile(db, main(), deps);
		const row = db.prepare("SELECT * FROM transcript_lines").get() as Record<string, unknown>;
		expect(row.payload).toBeInstanceOf(Uint8Array);
		expect(row.file_id).toBe(transcriptRow().id);
		expect(row).not.toHaveProperty("path");
		expect(row).toMatchObject({ session_id: SID, agent_id: null, type: "user", uuid: "a" });
	});

	it("counts parse errors but not a trailing partial line", () => {
		const p = writeTranscript(h.claude, "proj", SID, [u("one", "a")]);
		appendFileSync(p, 'garbage\n[1,2]\n{"type":"user"');
		const r = ingestFile(db, main(), deps);
		expect(r).toMatchObject({ lines: 3, parseErrors: 2 });
		expect(transcriptRow()).toMatchObject({ lines: 3, parse_errors: 2 });
		expect(count("SELECT count(*) n FROM transcript_lines")).toBe(1);
	});

	it("handles CRLF line endings", () => {
		const p = writeTranscript(h.claude, "proj", SID, []);
		writeFileSync(p, `${JSON.stringify(u("one", "a"))}\r\n${JSON.stringify(u("two", "b"))}\r\n`);
		expect(ingestFile(db, main(), deps)).toMatchObject({ lines: 2, parseErrors: 0 });
	});

	it("reads lines longer than one chunk and files spanning many chunks", () => {
		const big = "é".repeat(700_000); // 1.4 MB line, multibyte across the chunk boundary
		const lines = [u(big, "a"), ...Array.from({ length: 3000 }, (_, i) => u(`line ${i} ${"z".repeat(500)}`, `b${i}`))];
		writeTranscript(h.claude, "proj", SID, lines);
		const r = ingestFile(db, main(), deps);
		expect(r).toMatchObject({ lines: 3001, parseErrors: 0 });
		expect(count("SELECT count(*) n FROM transcript_lines")).toBe(3001);
		expect(transcriptRow().bytes_ingested).toBe(main().size);
	});
});

describe("ingestSession and ingestPending", () => {
	const subLine = (uuid: string) => ({
		type: "assistant",
		uuid,
		isSidechain: true,
		agentId: "ag1",
		message: { content: [] },
	});

	it("ingests subagent files with agent_id and derives the parent session once", () => {
		writeTranscript(h.claude, "proj", SID, [u("one", "a")]);
		writeTranscript(h.claude, "proj", SID, [subLine("s1"), subLine("s2")], { agentId: "ag1" });
		const r = ingestSession(db, SID, deps);
		expect(r).toMatchObject({ files: 2, lines: 3, sessions: [SID] });
		expect(derived).toEqual([SID]);
		expect(
			db.prepare("SELECT agent_id, count(*) n FROM transcript_lines GROUP BY agent_id ORDER BY agent_id").all(),
		).toEqual([
			{ agent_id: null, n: 1 },
			{ agent_id: "ag1", n: 2 },
		]);
	});

	it("skips the subagent files of an internal session", () => {
		writeTranscript(h.claude, "proj", SID, [u("[cc-debrief:summary] x", "a")]);
		writeTranscript(h.claude, "proj", SID, [subLine("s1")], { agentId: "ag1" });
		ingestSession(db, SID, deps);
		expect(count("SELECT count(*) n FROM transcript_lines")).toBe(0);
		expect(derived).toEqual([]);
	});

	it("ingests every changed file, one derive per session", () => {
		writeTranscript(h.claude, "proj", SID, [u("one", "a")]);
		writeTranscript(h.claude, "proj", SID2, [u("two", "b")]);
		writeTranscript(h.claude, "proj", SID, [subLine("s1")], { agentId: "ag1" });
		const r = ingestPending(db, deps);
		expect(r).toMatchObject({ files: 3, lines: 3 });
		expect(r.sessions.sort()).toEqual([SID, SID2]);
		expect(derived.sort()).toEqual([SID, SID2]);
		expect(ingestPending(db, deps)).toEqual({ files: 0, lines: 0, parseErrors: 0, sessions: [] });
	});

	it("keeps rows and sets missing_since when a file disappears", () => {
		const p = writeTranscript(h.claude, "proj", SID, [u("one", "a")]);
		ingestPending(db, deps);
		rmSync(p);
		ingestPending(db, deps);
		expect(transcriptRow().missing_since).toEqual(expect.any(String));
		expect(count("SELECT count(*) n FROM transcript_lines")).toBe(1);
		const first = transcriptRow().missing_since;
		ingestPending(db, deps);
		expect(transcriptRow().missing_since).toBe(first); // set once
	});

	it("only looks at files modified since the given time", () => {
		const p = writeTranscript(h.claude, "proj", SID, [u("one", "a")]);
		const old = new Date(Date.now() - 3600_000);
		utimesSync(p, old, old);
		expect(ingestPending(db, { ...deps, since: new Date(Date.now() - 60_000) }).files).toBe(0);
		expect(ingestPending(db, deps).files).toBe(1);
	});
});

describe("ingestPendingLocked", () => {
	it("skips a session whose lock is held and ingests it once the lock is free", async () => {
		writeTranscript(h.claude, "proj", SID, [u("one", "a")]);
		writeTranscript(h.claude, "proj", SID2, [u("two", "b")]);
		const whileHeld = await withSessionLock(SID, { waitMs: 0 }, () => ingestPendingLocked(db, deps));
		expect(whileHeld).toMatchObject({ files: 1, sessions: [SID2] });
		expect(await ingestPendingLocked(db, deps)).toMatchObject({ files: 1, sessions: [SID] });
		expect(await ingestPendingLocked(db, deps)).toEqual({ files: 0, lines: 0, parseErrors: 0, sessions: [] });
	});

	it("leaves out a never-read file last written before the retention window, until it is appended to (review A3)", () => {
		const p = writeTranscript(h.claude, "proj", SID, [u("old", "a", daysAgo(100))]);
		const past = new Date(daysAgo(100));
		utimesSync(p, past, past);
		expect(pendingGroups(db, { config: loadConfig() }).bySession.size).toBe(0);
		expect(pendingGroups(db, { config: { ...loadConfig(), retention: { days: 0 } } }).bySession.size).toBe(1);
		appendFileSync(p, jsonl(u("resumed", "b")));
		expect([...pendingGroups(db, { config: loadConfig() }).bySession.keys()]).toEqual([SID]);
	});
});

describe("recheck (ingest --all)", () => {
	it("re-reads a file rewritten with the same size and mtime only when recheck is set", () => {
		const fixed = new Date("2026-09-29T10:00:00Z");
		const p = writeTranscript(h.claude, "proj", SID, [u("one", "aaaa")]);
		utimesSync(p, fixed, fixed);
		ingestPending(db, deps);
		writeFileSync(p, jsonl(u("two", "bbbb")));
		utimesSync(p, fixed, fixed);
		expect(ingestPending(db, deps).files).toBe(0);
		const r = ingestPending(db, { ...deps, recheck: true });
		expect(r).toMatchObject({ files: 1, lines: 1, sessions: [SID] });
		expect(transcriptRow().first_line_uuid).toBe("bbbb");
		expect(ingestPending(db, { ...deps, recheck: true }).files).toBe(0); // same identity: nothing to do
	});
});

describe("deriveSessions", () => {
	it("derives each session once and drains the rederive queue", () => {
		setMeta(db, `rederive:${SID2}`, "1");
		deriveSessions(db, [SID, SID], deps);
		expect(derived).toEqual([SID, SID2]);
		expect(count("SELECT count(*) n FROM meta WHERE key LIKE 'rederive:%'")).toBe(0);
	});

	it("leaves a queued session whose lock another worker holds for later, and takes it once free (review A4)", async () => {
		setMeta(db, `rederive:${SID2}`, "1");
		mkdirSync(locksDir(), { recursive: true });
		const lock = join(locksDir(), `${SID2}.lock`);
		// a live process that is not this one: the test runner's parent
		writeFileSync(lock, JSON.stringify({ pid: process.ppid, startedAt: new Date().toISOString() }));
		deriveSessions(db, [SID], deps);
		expect(derived).toEqual([SID]);
		expect(count("SELECT count(*) n FROM meta WHERE key LIKE 'rederive:%'")).toBe(1);
		rmSync(lock);
		deriveSessions(db, [], deps);
		expect(derived).toEqual([SID, SID2]);
		expect(count("SELECT count(*) n FROM meta WHERE key LIKE 'rederive:%'")).toBe(0);
		expect(existsSync(lock)).toBe(false); // released
	});

	it("a session whose lock this process holds is drained under it", async () => {
		setMeta(db, `rederive:${SID}`, "1");
		await withSessionLock(SID, { waitMs: 0 }, async () => deriveSessions(db, [], deps));
		expect(derived).toEqual([SID]);
	});
});

describe("interrupted ingest", () => {
	it("derives a session whose previous ingest stopped between storing lines and deriving", () => {
		writeTranscript(h.claude, "proj", SID, [u("one", "a"), u("two", "b")]);
		expect(() =>
			ingestPending(db, {
				derive: () => {
					throw new Error("killed");
				},
			}),
		).toThrow("killed");
		expect(count("SELECT count(*) n FROM transcript_lines")).toBe(2);
		const r = ingestPending(db); // the next run, with the real derive
		expect(r.sessions).toEqual([SID]);
		expect(count("SELECT count(*) n FROM sessions")).toBe(1);
		expect(count("SELECT count(*) n FROM turns")).toBe(2);
		expect(ingestPending(db).sessions).toEqual([]); // and then it is done
	});

	it("re-derives after an interrupted run that appended to an already ingested file", () => {
		const p = writeTranscript(h.claude, "proj", SID, [u("one", "a")]);
		ingestPending(db);
		appendFileSync(p, jsonl(u("two", "b")));
		expect(() =>
			ingestPending(db, {
				derive: () => {
					throw new Error("killed");
				},
			}),
		).toThrow("killed");
		ingestPending(db);
		expect(count("SELECT count(*) n FROM turns")).toBe(2);
	});
});

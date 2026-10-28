import { appendFileSync, existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { callTranscriptsDir } from "../../src/claude/headless";
import { type Config, ConfigSchema } from "../../src/config";
import type { Db } from "../../src/db/adapter";
import { getMeta, setMeta } from "../../src/db/queries/meta";
import { purgeAll, purgeOlderThan, retentionPreview, runRetention } from "../../src/db/queries/retention";
import { ingestPending } from "../../src/ingest/ingest";
import { rawDir } from "../../src/paths";
import { writeTranscript } from "../helpers/fixtures";
import { seedDb, storeLines } from "../helpers/seed";
import { type TmpHome, tmpHome } from "../helpers/tmp-home";

const DAY = 86_400_000;
const NOW = new Date("2026-10-02T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * DAY).toISOString();
const cfg = (days: number): Config => {
	const c = ConfigSchema.parse({});
	return { ...c, retention: { days } };
};

let h: TmpHome;
let db: Db;
beforeEach(() => {
	h = tmpHome();
	db = seedDb();
});
afterEach(() => {
	db.close();
	h.cleanup();
});

const n = (sql: string, ...p: unknown[]) => (db.prepare(sql).get(...p) as { n: number }).n;

function seedFull(id: string, ageDays: number) {
	const ts = daysAgo(ageDays);
	db.prepare("INSERT INTO sessions (session_id, started_at, ended_at) VALUES (?, ?, ?)").run(id, ts, ts);
	db.prepare("INSERT INTO events (session_id, event, ts, payload) VALUES (?, 'SessionStart', ?, '{}')").run(id, ts);
	const turn = Number(db.prepare("INSERT INTO turns (session_id, seq) VALUES (?, 0)").run(id).lastInsertRowid);
	db.prepare("INSERT INTO usage (session_id, turn_id, model, ts) VALUES (?, ?, 'm', ?)").run(id, turn, ts);
	db.prepare("INSERT INTO tool_calls (session_id, turn_id, tool_name) VALUES (?, ?, 'Edit')").run(id, turn);
	db.prepare("INSERT INTO file_changes (session_id, path) VALUES (?, 'a.ts')").run(id);
	db.prepare("INSERT INTO subagents (session_id, agent_id) VALUES (?, 'ag')").run(id);
	db.prepare("INSERT INTO compactions (session_id, ts) VALUES (?, ?)").run(id, ts);
	db.prepare("INSERT INTO instructions_loaded (session_id, file_path) VALUES (?, 'CLAUDE.md')").run(id);
	db.prepare(
		"INSERT OR IGNORE INTO inventory (scope, kind, name, path, first_seen, last_seen) VALUES ('user', 'skill', 'x', '/x', 'a', 'b')",
	).run();
	db.prepare(
		"INSERT INTO inventory_usage (inventory_id, session_id, loaded) VALUES ((SELECT id FROM inventory LIMIT 1), ?, 1)",
	).run(id);
	storeLines(db, id, [
		{ type: "user", uuid: `${id}-1`, timestamp: ts, message: { content: "hi" } },
		{ type: "assistant", uuid: `${id}-2`, timestamp: ts, message: { content: [] } },
	]);
	setMeta(db, `derive:${id}`, "{}");
}

const TABLES = [
	"sessions",
	"events",
	"turns",
	"usage",
	"tool_calls",
	"file_changes",
	"subagents",
	"compactions",
	"instructions_loaded",
	"inventory_usage",
	"transcript_lines",
];

describe("purgeOlderThan", () => {
	beforeEach(() => {
		seedFull("old", 100);
		seedFull("mid", 50);
		seedFull("new", 10);
	});

	it("deletes the sessions started before the cutoff with every dependent row", () => {
		const counts = purgeOlderThan(db, new Date(NOW.getTime() - 90 * DAY), { now: NOW });
		for (const t of TABLES) {
			expect(n(`SELECT count(*) AS n FROM ${t} WHERE session_id = 'old'`), t).toBe(0);
			expect(n(`SELECT count(*) AS n FROM ${t} WHERE session_id = 'mid'`), t).toBeGreaterThan(0);
			expect(n(`SELECT count(*) AS n FROM ${t} WHERE session_id = 'new'`), t).toBeGreaterThan(0);
		}
		expect(counts).toMatchObject({ sessions: 1, transcript_lines: 2, events: 1, turns: 1, usage: 1, tool_calls: 1 });
		expect(counts.bytes).toBeGreaterThan(0);
		expect(n("SELECT count(*) AS n FROM inventory")).toBe(1); // kept
		expect(getMeta(db, "derive:old")).toBeNull();
		const t = db.prepare("SELECT purged_at FROM transcripts WHERE session_id = 'old'").get() as { purged_at: string };
		expect(t.purged_at).toBe(NOW.toISOString());
	});

	it("also deletes old ledger rows, orphan events, expired dismissals and raw dumps", () => {
		db.prepare(
			"INSERT INTO self_usage (feature, session_id, ts) VALUES ('summary', 'f-old', ?), ('summary', 'f-new', ?)",
		).run(daysAgo(100), daysAgo(1));
		db.prepare("INSERT INTO ai_calls (feature, ts) VALUES ('summary', ?), ('summary', ?)").run(
			daysAgo(100),
			daysAgo(1),
		);
		db.prepare(
			"INSERT INTO events (session_id, event, ts, payload) VALUES ('ghost', 'PermissionRequest', ?, '{}')",
		).run(daysAgo(95));
		setMeta(db, "dismiss:rule:x", daysAgo(1)); // expired
		setMeta(db, "dismiss:rule:y", new Date(NOW.getTime() + DAY).toISOString()); // still active
		mkdirSync(rawDir(), { recursive: true });
		const oldDump = join(rawDir(), "old.json");
		const newDump = join(rawDir(), "new.json");
		writeFileSync(oldDump, "{}");
		writeFileSync(newDump, "{}");
		utimesSync(oldDump, new Date(daysAgo(100)), new Date(daysAgo(100)));
		utimesSync(newDump, NOW, NOW);

		const counts = purgeOlderThan(db, new Date(NOW.getTime() - 90 * DAY), { now: NOW });
		expect(counts).toMatchObject({ self_usage: 1, ai_calls: 1, raw_files: 1 });
		expect(n("SELECT count(*) AS n FROM self_usage")).toBe(1);
		expect(n("SELECT count(*) AS n FROM ai_calls")).toBe(1);
		expect(n("SELECT count(*) AS n FROM events WHERE session_id = 'ghost'")).toBe(0);
		expect(getMeta(db, "dismiss:rule:x")).toBeNull();
		expect(getMeta(db, "dismiss:rule:y")).not.toBeNull();
		expect(existsSync(oldDump)).toBe(false);
		expect(existsSync(newDump)).toBe(true);
	});

	it("sweeps leftover transcripts of the tracker's own calls by age; purgeAll sweeps them all", () => {
		const dir = callTranscriptsDir();
		mkdirSync(join(dir, "old-call"), { recursive: true });
		const old = join(dir, "old-call.jsonl");
		const fresh = join(dir, "new-call.jsonl");
		writeFileSync(old, "{}");
		writeFileSync(fresh, "{}");
		for (const p of [old, join(dir, "old-call")]) utimesSync(p, new Date(daysAgo(100)), new Date(daysAgo(100)));
		utimesSync(fresh, NOW, NOW);
		expect(purgeOlderThan(db, new Date(NOW.getTime() - 90 * DAY), { now: NOW }).call_transcripts).toBe(2);
		expect(existsSync(old)).toBe(false);
		expect(existsSync(join(dir, "old-call"))).toBe(false);
		expect(existsSync(fresh)).toBe(true);
		expect(purgeAll(db, { dryRun: true }).call_transcripts).toBe(1);
		expect(existsSync(fresh)).toBe(true);
		expect(purgeAll(db).call_transcripts).toBe(1);
		expect(existsSync(fresh)).toBe(false);
	});

	it("dry run counts without deleting anything", () => {
		const counts = purgeOlderThan(db, new Date(NOW.getTime() - 90 * DAY), { now: NOW, dryRun: true });
		expect(counts.sessions).toBe(1);
		expect(counts.transcript_lines).toBe(2);
		expect(n("SELECT count(*) AS n FROM sessions")).toBe(3);
		expect(n("SELECT count(*) AS n FROM transcript_lines")).toBe(6);
		expect(n("SELECT count(*) AS n FROM transcripts WHERE purged_at IS NOT NULL")).toBe(0);
	});
});

describe("no re-import after deletion", () => {
	const SID = "11111111-1111-1111-1111-111111111111";
	const line = (uuid: string, ts: string) => ({
		type: "user",
		uuid,
		timestamp: ts,
		sessionId: SID,
		message: { role: "user", content: "hello" },
	});

	it("a purged transcript still on disk is not imported again, even when it grows", () => {
		const old = new Date(Date.now() - 100 * DAY).toISOString();
		const path = writeTranscript(h.claude, "proj", SID, [line("a", old)]);
		ingestPending(db, { config: cfg(0) });
		expect(n("SELECT count(*) AS n FROM sessions WHERE session_id = ?", SID)).toBe(1);
		purgeOlderThan(db, new Date(Date.now() - 90 * DAY));
		appendFileSync(path, `${JSON.stringify(line("b", old))}\n`);
		ingestPending(db, { config: cfg(0) });
		expect(n("SELECT count(*) AS n FROM sessions WHERE session_id = ?", SID)).toBe(0);
		expect(n("SELECT count(*) AS n FROM transcript_lines")).toBe(0);
	});

	it("purgeAll keeps schema_version and init.*, sets ingest_not_before, and older transcripts stay out", () => {
		const path = writeTranscript(h.claude, "proj", SID, [line("a", new Date().toISOString())]);
		ingestPending(db, { config: cfg(0) });
		setMeta(db, "init.before_sha256", "abc");
		setMeta(db, "last_retention_run", "x");
		db.prepare("INSERT INTO repos (repo_id, root_path, name) VALUES ('r', '/r', 'r')").run();
		const past = new Date(Date.now() - 60_000);
		utimesSync(path, past, past);

		const counts = purgeAll(db);
		expect(counts.sessions).toBe(1);
		const tables = db
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
			.all<{ name: string }>()
			.map((r) => r.name)
			.filter((t) => t !== "meta");
		for (const t of tables) expect(n(`SELECT count(*) AS n FROM ${t}`), t).toBe(0);
		expect(
			db
				.prepare("SELECT key FROM meta ORDER BY key")
				.all<{ key: string }>()
				.map((r) => r.key),
		).toEqual(["ingest_not_before", "init.before_sha256", "schema_version"]);

		ingestPending(db, { config: cfg(0) });
		expect(n("SELECT count(*) AS n FROM sessions")).toBe(0);
		// A transcript written after the purge is imported normally.
		writeTranscript(h.claude, "proj2", "22222222-2222-2222-2222-222222222222", [line("c", new Date().toISOString())]);
		ingestPending(db, { config: cfg(0) });
		expect(n("SELECT count(*) AS n FROM sessions")).toBe(1);
	});
});

describe("retention by last activity", () => {
	it("keeps a session started long ago that is still in use, in the purge and the preview", () => {
		seedFull("resumed", 100);
		db.prepare("UPDATE sessions SET ended_at = ? WHERE session_id = 'resumed'").run(daysAgo(2));
		db.prepare(
			"INSERT INTO events (session_id, event, ts, payload) VALUES ('resumed', 'PermissionRequest', ?, '{}')",
		).run(daysAgo(95));
		seedFull("stale", 100);
		expect(retentionPreview(db, 90, NOW)).toBe(1);
		const counts = purgeOlderThan(db, new Date(NOW.getTime() - 90 * DAY), { now: NOW });
		expect(counts.sessions).toBe(1);
		expect(n("SELECT count(*) AS n FROM sessions WHERE session_id = 'resumed'")).toBe(1);
		expect(n("SELECT count(*) AS n FROM transcripts WHERE session_id = 'resumed' AND purged_at IS NOT NULL")).toBe(0);
		// its old events (SessionStart, PermissionRequest) stay with it (review B10)
		expect(n("SELECT count(*) AS n FROM events WHERE session_id = 'resumed'")).toBe(2);
	});
});

describe("purgeAll with linked rows", () => {
	it("deletes sessions that reference a repo and inventory, for real and as a dry run", () => {
		db.prepare(
			"INSERT INTO repos (repo_id, root_path, name) VALUES ('github.com/example-org/billing-api', '/w/b', 'billing-api')",
		).run();
		seedFull("linked", 5);
		db.prepare("UPDATE sessions SET repo_id = 'github.com/example-org/billing-api' WHERE session_id = 'linked'").run();
		expect(purgeAll(db, { dryRun: true }).sessions).toBe(1);
		expect(n("SELECT count(*) AS n FROM sessions")).toBe(1);
		expect(purgeAll(db).sessions).toBe(1);
		for (const t of ["sessions", "repos", "inventory", "inventory_usage"]) {
			expect(n(`SELECT count(*) AS n FROM ${t}`), t).toBe(0);
		}
	});
});

describe("runRetention", () => {
	it("runs at most once per 24 h", () => {
		seedFull("old", 100);
		expect(runRetention(db, cfg(90), NOW)).toMatchObject({ sessions: 1 });
		seedFull("old2", 100);
		expect(runRetention(db, cfg(90), new Date(NOW.getTime() + 23 * 3_600_000))).toBe("skipped");
		expect(runRetention(db, cfg(90), new Date(NOW.getTime() + 25 * 3_600_000))).toMatchObject({ sessions: 1 });
	});

	it("is skipped when retention.days is 0", () => {
		seedFull("old", 100);
		expect(runRetention(db, cfg(0), NOW)).toBe("skipped");
		expect(n("SELECT count(*) AS n FROM sessions")).toBe(1);
	});
});

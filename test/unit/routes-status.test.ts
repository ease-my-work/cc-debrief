import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HOOK_MARKER } from "../../src/claude/settings";
import { setConfigValue } from "../../src/config";
import type { Db } from "../../src/db/adapter";
import { getStatus } from "../../src/db/queries/status";
import { createApp } from "../../src/server/app";
import { setBackfillProgress, setTier1Progress } from "../../src/server/progress";
import type { StatusResponse } from "../../src/server/types";
import { VERSION } from "../../src/version";
import { writeTree } from "../helpers/claude-tree";
import { seedDb, storeLines } from "../helpers/seed";
import { type TmpHome, tmpHome } from "../helpers/tmp-home";

let h: TmpHome;
let db: Db;
beforeEach(() => {
	h = tmpHome();
	db = seedDb();
});
afterEach(() => {
	setBackfillProgress(null);
	db.close();
	h.cleanup();
});

const NOW = new Date("2026-10-02T12:00:00Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";

function session(id: string, lastLineAt: string) {
	db.prepare("INSERT INTO sessions (session_id, started_at, ended_at) VALUES (?, ?, ?)").run(
		id,
		minutesAgo(90),
		lastLineAt,
	);
	storeLines(db, id, [
		{ type: "user", uuid: `u-${id}`, timestamp: lastLineAt, message: { role: "user", content: "x" } },
	]);
}

describe("getStatus", () => {
	it("reports defaults on an empty DB", () => {
		expect(getStatus(db, NOW)).toEqual({
			ai: { summaries: true, reviews: false, autoReview: false, drafts: false },
			lastIngestAt: null,
			lastHookEventAt: null,
			hooksInstalled: false,
			backfill: null,
			summaryJob: null,
			reviewJob: null,
			tier1Job: null,
			inProgressSessions: 0,
			pollSeconds: 15,
			pendingSummaries: 0,
			pendingImportedSummaries: 0,
			version: VERSION,
		} satisfies StatusResponse);
	});

	it("reports the Tier 1 job's progress while it runs", () => {
		setTier1Progress({ done: 1, total: 4 });
		expect(getStatus(db, NOW).tier1Job).toEqual({ done: 1, total: 4 });
		setTier1Progress(null);
		expect(getStatus(db, NOW).tier1Job).toBeNull();
	});

	it("follows config for the AI flags and poll interval", () => {
		setConfigValue("ai.summaries.enabled", "false");
		setConfigValue("ai.review.enabled", "true");
		setConfigValue("dashboard.pollSeconds", "5");
		const s = getStatus(db, NOW);
		expect(s.ai).toEqual({ summaries: false, reviews: true, autoReview: false, drafts: false });
		expect(s.pollSeconds).toBe(5);
	});

	it("sees our hooks in settings.json, and not someone else's", () => {
		writeTree(h.claude, {
			"settings.json": { hooks: { Stop: [{ hooks: [{ type: "command", command: "echo other" }] }] } },
		});
		expect(getStatus(db, NOW).hooksInstalled).toBe(false);
		writeTree(h.claude, {
			"settings.json": {
				hooks: { Stop: [{ hooks: [{ type: "command", command: `node "/b/hook.js" ${HOOK_MARKER}` }] }] },
			},
		});
		expect(getStatus(db, NOW).hooksInstalled).toBe(true);
	});

	it("tolerates an unreadable settings.json", () => {
		writeTree(h.claude, { "settings.json": "{ nope" });
		expect(getStatus(db, NOW).hooksInstalled).toBe(false);
	});

	it("counts a session in progress: no SessionEnd and a line under 30 minutes old", () => {
		session(A, minutesAgo(5));
		session(B, minutesAgo(40));
		expect(getStatus(db, NOW).inProgressSessions).toBe(1);
		db.prepare("INSERT INTO events (session_id, event, ts, payload) VALUES (?, 'SessionEnd', ?, '{}')").run(
			A,
			minutesAgo(1),
		);
		expect(getStatus(db, NOW).inProgressSessions).toBe(0);
	});

	it("reports the last ingest, the last hook event and backfill progress", () => {
		db.prepare(
			"INSERT INTO transcripts (path, session_id, size, mtime_ms, last_ingested_at) VALUES ('/a', 'x', 0, 0, ?), ('/b', 'y', 0, 0, ?)",
		).run(minutesAgo(10), minutesAgo(2));
		db.prepare("INSERT INTO events (session_id, event, ts, payload) VALUES ('x', 'SessionStart', ?, '{}')").run(
			minutesAgo(3),
		);
		setBackfillProgress({ done: 120, total: 283 });
		const s = getStatus(db, NOW);
		expect(s.lastIngestAt).toBe(minutesAgo(2));
		expect(s.lastHookEventAt).toBe(minutesAgo(3));
		expect(s.backfill).toEqual({ done: 120, total: 283 });
	});
});

describe("GET /api/status", () => {
	it("returns the status JSON", async () => {
		const r = await createApp(db, { port: 4242, uiDir: "/x" }).request("/api/status", {
			headers: { host: "127.0.0.1:4242" },
		});
		expect(r.status).toBe(200);
		const body = (await r.json()) as StatusResponse;
		expect(body.version).toBe(VERSION);
		expect(body.hooksInstalled).toBe(false);
	});
});

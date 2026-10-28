import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ClaudeResult } from "../../src/claude/headless";
import type { Db } from "../../src/db/adapter";
import { setMeta } from "../../src/db/queries/meta";
import {
	aiCallsToday,
	cleanupInternalSessions,
	isInternalSession,
	recordSelfUsage,
	selfUsageLine,
	selfUsageSummary,
} from "../../src/db/queries/selfUsage";
import { seedDb, storeLines } from "../helpers/seed";
import { type TmpHome, tmpHome } from "../helpers/tmp-home";

const NOW = new Date(2026, 9, 2, 12, 0, 0); // local noon
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();

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

const result = (sessionId: string, over: Partial<ClaudeResult<unknown>> = {}): ClaudeResult<unknown> => ({
	result: {},
	sessionId,
	costUsd: 0.02,
	rawTotalCostUsd: 0.2,
	usage: { inputTokens: 10, outputTokens: 92, cacheCreationTokens: 1531, cacheReadTokens: 49643 },
	model: "claude-haiku-4-5",
	...over,
});

function selfRow(
	feature: string,
	id: string,
	ts: string,
	usd: number | null,
	t: [number, number, number, number] = [0, 0, 0, 0],
) {
	db.prepare(
		`INSERT INTO self_usage (feature, session_id, model, input_tokens, output_tokens, cache_creation_tokens,
		 cache_read_tokens, cost_usd, ts) VALUES (?, ?, 'claude-haiku-4-5', ?, ?, ?, ?, ?, ?)`,
	).run(feature, id, ...t, usd, ts);
}
function aiCall(feature: string, ts: string, sessionId: string | null = null) {
	db.prepare("INSERT INTO ai_calls (feature, session_id, ts) VALUES (?, ?, ?)").run(feature, sessionId, ts);
}
function userUsage(usd: number, ts: string) {
	db.prepare("INSERT OR IGNORE INTO sessions (session_id, started_at) VALUES ('user-1', ?)").run(ts);
	db.prepare("INSERT INTO usage (session_id, model, cost_usd, ts) VALUES ('user-1', 'claude-sonnet-4-5', ?, ?)").run(
		usd,
		ts,
	);
}

describe("recordSelfUsage", () => {
	it("upserts by session_id", () => {
		recordSelfUsage(db, "summary", result("fork-1"), "user-a");
		recordSelfUsage(db, "summary", result("fork-1", { costUsd: 0.05 }), "user-a");
		const rows = db.prepare("SELECT * FROM self_usage").all<Record<string, unknown>>();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			feature: "summary",
			session_id: "fork-1",
			target_session_id: "user-a",
			model: "claude-haiku-4-5",
			input_tokens: 10,
			output_tokens: 92,
			cache_creation_tokens: 1531,
			cache_read_tokens: 49643,
			cost_usd: 0.05,
			raw_total_cost_usd: 0.2,
		});
	});
});

describe("isInternalSession", () => {
	it("is true for ids in self_usage or ai_calls.session_id, false otherwise", () => {
		recordSelfUsage(db, "summary", result("fork-1"));
		aiCall("review", ago(0), "fork-2");
		aiCall("review", ago(0)); // a pending attempt has no session id yet
		expect(isInternalSession(db, "fork-1")).toBe(true);
		expect(isInternalSession(db, "fork-2")).toBe(true);
		expect(isInternalSession(db, "user-1")).toBe(false);
	});
});

describe("cleanupInternalSessions", () => {
	it("removes every row a leaked internal session left and marks its transcripts internal", () => {
		const leak = "fork-leak";
		recordSelfUsage(db, "summary", result(leak));
		db.prepare("INSERT INTO sessions (session_id, started_at) VALUES (?, ?)").run(leak, ago(0));
		db.prepare("INSERT INTO sessions (session_id, started_at) VALUES ('user-1', ?)").run(ago(0));
		for (const sid of [leak, "user-1"]) {
			db.prepare("INSERT INTO events (session_id, event, ts, payload) VALUES (?, 'SessionStart', ?, '{}')").run(
				sid,
				ago(0),
			);
			db.prepare("INSERT INTO turns (session_id, seq) VALUES (?, 0)").run(sid);
			db.prepare("INSERT INTO usage (session_id, model, ts) VALUES (?, 'm', ?)").run(sid, ago(0));
			db.prepare("INSERT INTO tool_calls (session_id, tool_name) VALUES (?, 'Read')").run(sid);
			storeLines(db, sid, [{ type: "user", uuid: `${sid}-u`, message: { content: "hi" } }]);
			setMeta(db, `derive:${sid}`, "{}");
		}

		expect(cleanupInternalSessions(db)).toBe(1);

		const n = (sql: string, id: string) => (db.prepare(sql).get(id) as { n: number }).n;
		for (const table of ["sessions", "events", "turns", "usage", "tool_calls", "transcript_lines"]) {
			expect(n(`SELECT count(*) AS n FROM ${table} WHERE session_id = ?`, leak), table).toBe(0);
			expect(n(`SELECT count(*) AS n FROM ${table} WHERE session_id = ?`, "user-1"), table).toBe(1);
		}
		expect(n("SELECT count(*) AS n FROM meta WHERE key = 'derive:' || ?", leak)).toBe(0);
		expect(db.prepare("SELECT internal FROM transcripts WHERE session_id = ?").get(leak)).toEqual({ internal: 1 });
		expect(db.prepare("SELECT internal FROM transcripts WHERE session_id = 'user-1'").get()).toEqual({ internal: 0 });
		expect(cleanupInternalSessions(db)).toBe(0); // nothing left the second time
	});
});

describe("selfUsageSummary", () => {
	beforeEach(() => {
		selfRow("summary", "s-1", ago(1), 0.6, [40_000, 20_000, 6_000, 80_000]);
		selfRow("summary", "s-2", ago(2), 0.4, [20_000, 5_000, 5_000, 70_000]);
		selfRow("review", "r-1", ago(3), 0.4, [20_000, 10_000, 4_000, 30_000]);
		selfRow("summary", "s-old", ago(10), 0.5, [1_000, 0, 0, 0]); // 30d only
		userUsage(10.4, ago(1));
		userUsage(8, ago(4));
		userUsage(5, ago(20)); // 30d only
	});

	it("gives feature 15's table for 7 days", () => {
		const s = selfUsageSummary(db, "7d", NOW);
		expect(s.range).toBe("7d");
		expect(s.userUsd).toBeCloseTo(18.4, 6);
		const by = Object.fromEntries(s.byFeature.map((f) => [f.feature, f]));
		expect(by.summary).toMatchObject({ calls: 2, failed: 0, tokens: 246_000, cacheReadTokens: 150_000 });
		expect(by.summary.usd).toBeCloseTo(1.0, 6);
		expect(by.summary.sharePct).toBeCloseTo(5.1, 1);
		expect(by.review).toMatchObject({ calls: 1, failed: 0, tokens: 64_000, cacheReadTokens: 30_000 });
		expect(by.review.sharePct).toBeCloseTo(2.0, 1);
		expect(by.draft).toMatchObject({ calls: 0, failed: 0, tokens: 0, usd: 0, sharePct: 0 });
		expect(s.byFeature.map((f) => f.feature)).toEqual(["summary", "review", "draft", "recap"]);
		expect(s.total).toMatchObject({ calls: 3, failed: 0, tokens: 310_000 });
		expect(s.total.usd).toBeCloseTo(1.4, 6);
		expect(s.total.sharePct).toBeCloseTo(7.1, 1);
	});

	it("widens to 30 days", () => {
		const s = selfUsageSummary(db, "30d", NOW);
		expect(s.total.calls).toBe(4);
		expect(s.total.usd).toBeCloseTo(1.9, 6);
		expect(s.userUsd).toBeCloseTo(23.4, 6);
	});

	it("counts an attempt without a self_usage row as a failed call", () => {
		aiCall("review", ago(1)); // crashed: no session id, no usage row
		aiCall("summary", ago(1), "s-1"); // finished: matches its usage row
		const by = Object.fromEntries(selfUsageSummary(db, "7d", NOW).byFeature.map((f) => [f.feature, f]));
		expect(by.review).toMatchObject({ calls: 2, failed: 1 });
		expect(by.summary).toMatchObject({ calls: 2, failed: 0 });
	});

	it("excludes unpriced calls from USD but keeps their tokens", () => {
		selfRow("draft", "d-1", ago(1), null, [100, 0, 0, 0]);
		const by = Object.fromEntries(selfUsageSummary(db, "7d", NOW).byFeature.map((f) => [f.feature, f]));
		expect(by.draft).toMatchObject({ calls: 1, tokens: 100, usd: 0 });
	});
});

describe("sharePct", () => {
	it("is null when user and self USD are both 0", () => {
		expect(selfUsageSummary(db, "7d", NOW).total.sharePct).toBeNull();
	});

	it("rounds to two decimals, so a tiny share stays above 0", () => {
		selfRow("summary", "s-1", ago(1), 0.001);
		userUsage(10, ago(1));
		const s = selfUsageSummary(db, "7d", NOW);
		expect(s.total.sharePct).toBe(0.01);
	});
});

describe("selfUsageLine", () => {
	it("counts calls per feature over the last 7 days", () => {
		selfRow("summary", "s-1", ago(1), 1.0, [200_000, 0, 0, 0]);
		selfRow("review", "r-1", ago(1), 0.4, [110_000, 0, 0, 0]);
		selfRow("summary", "s-old", ago(9), 9.0);
		userUsage(18.4, ago(1));
		expect(selfUsageLine(db, NOW)).toEqual({
			summaries: 1,
			reviews: 1,
			drafts: 0,
			recaps: 0,
			tokens: 310_000,
			usd: 1.4,
			sharePct: expect.closeTo(7.07, 2),
		});
	});
});

describe("selfUsageLine recaps", () => {
	it("counts recap calls for the footer's + N recaps", () => {
		selfRow("recap", "p-1", ago(1), 0.01);
		selfRow("recap", "p-2", ago(2), 0.02);
		expect(selfUsageLine(db, NOW).recaps).toBe(2);
	});
});

describe("aiCallsToday", () => {
	it("counts the feature's attempts since local midnight only", () => {
		const now = new Date(2026, 9, 2, 0, 30);
		aiCall("summary", new Date(2026, 9, 1, 23, 50).toISOString()); // yesterday
		aiCall("summary", new Date(2026, 9, 2, 0, 10).toISOString());
		aiCall("summary", new Date(2026, 9, 2, 0, 20).toISOString(), "fork-1");
		aiCall("review", new Date(2026, 9, 2, 0, 20).toISOString());
		expect(aiCallsToday(db, "summary", now)).toBe(2);
		expect(aiCallsToday(db, "review", now)).toBe(1);
	});
});

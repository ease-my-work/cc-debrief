import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PRICE_TABLE_VERSION } from "../../src/collector/prices";
import { type Config, loadConfig } from "../../src/config";
import type { Db } from "../../src/db/adapter";
import { getMeta } from "../../src/db/queries/meta";
import { sessionTotals } from "../../src/db/queries/usage";
import { deriveSession, surfaceFromEntrypoint } from "../../src/derive/session";
import { ingestPending, ingestSession } from "../../src/ingest/ingest";
import { copyFixtureInto, FIXTURES, loadFixtureCases, readExpected, writeTranscript } from "../helpers/fixtures";
import { seedDb, storeLines as storeLinesIn } from "../helpers/seed";
import { type TmpHome, tmpHome } from "../helpers/tmp-home";

const basic = readExpected("basic");
const SID = basic.sessionId as string;
const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";

let h: TmpHome;
let db: Db;
let config: Config;
beforeEach(() => {
	h = tmpHome();
	db = seedDb();
	config = { ...loadConfig(), retention: { days: 0 } }; // fixtures age; never skip them
});
afterEach(() => {
	db.close();
	h.cleanup();
});

type Row = Record<string, unknown>;
const all = (sql: string, ...p: unknown[]) => db.prepare(sql).all<Row>(...p);
const one = (sql: string, ...p: unknown[]) => db.prepare(sql).get<Row>(...p) as Row;

const T = (s: string) => `2026-09-01T10:${s}.000Z`;
const prompt = (ts: string, text: string, promptId = `p-${ts}`) => ({
	type: "user",
	uuid: `u-${ts}`,
	timestamp: T(ts),
	promptId,
	cwd: "/home/user/r",
	entrypoint: "cli",
	version: "2.1.284",
	permissionMode: "default",
	gitBranch: "main",
	message: { role: "user", content: text },
});
const reply = (ts: string, id: string, text = "ok", out = 10, model = "claude-opus-5-5") => ({
	type: "assistant",
	uuid: `a-${ts}-${id}`,
	timestamp: T(ts),
	requestId: `req-${id}`,
	message: {
		id,
		model,
		role: "assistant",
		content: [{ type: "text", text }],
		usage: { input_tokens: 1, output_tokens: out, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
	},
});
const costState = (usd: number) => ({ type: "cost-state", totalCostUSD: usd, modelUsage: {} });

function ingestBasic() {
	copyFixtureInto(h.claude, join(FIXTURES, "synthetic", "basic"));
	return ingestPending(db, { config });
}

const storeLines = (sessionId: string, lines: object[], agentId: string | null = null) =>
	storeLinesIn(db, sessionId, lines, agentId);

const addEvent = (sessionId: string, event: string, payload: object, ts = T("00")) =>
	db
		.prepare("INSERT INTO events (session_id, event, ts, payload) VALUES (?, ?, ?, ?)")
		.run(sessionId, event, ts, JSON.stringify(payload));

const dump = () =>
	Object.fromEntries(
		["sessions", "turns", "usage", "subagents", "compactions", "instructions_loaded"].map((t) => [
			t,
			all(`SELECT * FROM ${t} ORDER BY rowid`),
		]),
	);

describe("deriveSession on the basic fixture", () => {
	it("writes every session value from basic.expected.json", () => {
		ingestBasic();
		const s = one("SELECT * FROM sessions WHERE session_id = ?", SID);
		const e = basic.session;
		expect({
			startedAt: s.started_at,
			endedAt: s.ended_at,
			cwd: s.cwd,
			branch: s.branch,
			permissionMode: s.permission_mode,
			ccVersion: s.cc_version,
			entrypoint: s.entrypoint,
			surface: s.surface,
			capture: s.capture,
			models: JSON.parse(s.models as string),
			title: s.title,
			agentName: s.agent_name,
			reportedCostUsd: s.reported_cost_usd,
		}).toEqual(e);
		expect(s.start_reason).toBeNull();
	});

	it("writes the turns", () => {
		ingestBasic();
		const turns = all("SELECT seq, prompt_id, user_text, started_at FROM turns WHERE session_id = ? ORDER BY seq", SID);
		expect(turns).toEqual(
			basic.turns.map((t: Row) => ({
				seq: t.seq,
				prompt_id: t.promptId,
				user_text: t.userText,
				started_at: t.startedAt,
			})),
		);
		const first = one("SELECT assistant_text, ended_at FROM turns WHERE seq = 1");
		expect(first).toEqual({ assistant_text: "Fixed the typo.", ended_at: T("00:07") });
	});

	it("writes usage rows with turn ids and costs, the subagent's with agent_id", () => {
		ingestBasic();
		const rows = all(
			`SELECT u.message_id, u.request_id, u.agent_id, u.model, u.input_tokens, u.output_tokens,
			        u.cache_creation_tokens, u.cache_read_tokens, t.seq AS turn_seq, u.cost_usd
			 FROM usage u LEFT JOIN turns t ON t.id = u.turn_id WHERE u.session_id = ? ORDER BY u.id`,
			SID,
		);
		expect(rows.map(({ cost_usd: _c, ...r }) => r)).toEqual(
			basic.usage.map((u: Row) => ({
				message_id: u.messageId,
				request_id: u.requestId,
				agent_id: u.agentId,
				model: u.model,
				input_tokens: u.inputTokens,
				output_tokens: u.outputTokens,
				cache_creation_tokens: u.cacheCreationTokens,
				cache_read_tokens: u.cacheReadTokens,
				turn_seq: u.turnSeq,
			})),
		);
		for (const r of rows) expect(r.cost_usd).toBeGreaterThan(0);
	});

	it("does not count the <synthetic> API-error reply", () => {
		ingestBasic();
		expect(JSON.parse(one("SELECT models FROM sessions").models as string)).not.toContain("<synthetic>");
		expect(one("SELECT count(*) AS n FROM usage WHERE model = '<synthetic>'").n).toBe(0);
	});

	it("writes subagents, compactions and instructions", () => {
		ingestBasic();
		expect(all("SELECT agent_id, agent_type, description, tool_use_id, started_at, ended_at FROM subagents")).toEqual(
			basic.subagents.map((s: Row) => ({
				agent_id: s.agentId,
				agent_type: s.agentType,
				description: s.description,
				tool_use_id: s.toolUseId,
				started_at: s.startedAt,
				ended_at: s.endedAt,
			})),
		);
		expect(all("SELECT ts, trigger, pre_tokens, post_tokens FROM compactions")).toEqual(
			basic.compactions.map((c: Row) => ({
				ts: c.ts,
				trigger: c.trigger,
				pre_tokens: c.preTokens,
				post_tokens: c.postTokens,
			})),
		);
		expect(all("SELECT file_path, kind, ts FROM instructions_loaded")).toEqual(
			basic.instructions.map((i: Row) => ({ file_path: i.filePath, kind: i.kind, ts: i.ts })),
		);
	});

	it("gives identical rows when derived twice", () => {
		ingestBasic();
		const before = dump();
		deriveSession(db, SID);
		expect(dump()).toEqual(before);
	});

	it("reports cost from the last cost-state line", () => {
		ingestBasic();
		const totals = sessionTotals(db, SID);
		expect(totals).toMatchObject({ source: "reported", partial: false, costUsd: 0.1234 });
		expect(totals.tokens).toEqual({
			inputTokens: 56,
			outputTokens: 217,
			cacheCreationTokens: 970,
			cacheReadTokens: 23000,
		});
		expect(JSON.parse(one("SELECT reported_usage FROM sessions").reported_usage as string)).toMatchObject({
			"claude-opus-5-5": { input: 52, output: 182, cacheRead: 16500, cacheCreation: 370, costUsd: 0.1 },
		});
	});

	it("records the price table version", () => {
		ingestBasic();
		expect(getMeta(db, "price_table_version")).toBe(PRICE_TABLE_VERSION);
	});
});

describe("deriveSession rules", () => {
	it("updates the title when a new custom-title line arrives", () => {
		const p = writeTranscript(h.claude, "proj", A, [prompt("00", "hi"), { type: "custom-title", customTitle: "One" }]);
		ingestPending(db, { config });
		appendFileSync(p, `${JSON.stringify({ type: "custom-title", customTitle: "Two" })}\n`);
		ingestPending(db, { config });
		expect(one("SELECT title FROM sessions").title).toBe("Two");
	});

	it("keeps AI, repo and git columns set by other workers", () => {
		writeTranscript(h.claude, "proj", A, [prompt("00", "hi"), reply("01", "m1")]);
		ingestPending(db, { config });
		db.prepare("INSERT INTO repos (repo_id, root_path, name) VALUES ('github.com/o/r', '/r', 'r')").run();
		db.prepare(
			`UPDATE sessions SET summary = 'x', session_type = 'bugfix', type_source = 'ai', outcome = 'done', tags = '["a"]',
			 summary_error = 'e', enriched_at = 'E', discard_checked_at = 'D', repo_id = 'github.com/o/r', branch = 'feat',
			 head_start = 'h1', head_start_source = 'snapshot', head_end = 'h2'`,
		).run();
		const before = one("SELECT * FROM sessions");
		deriveSession(db, A);
		const after = one("SELECT * FROM sessions");
		for (const k of [
			"summary",
			"session_type",
			"type_source",
			"outcome",
			"tags",
			"summary_error",
			"enriched_at",
			"discard_checked_at",
			"repo_id",
			"branch",
			"head_start",
			"head_start_source",
			"head_end",
		]) {
			expect(after[k], k).toBe(before[k]);
		}
	});

	it("sets capture and start_reason from the SessionStart event", () => {
		writeTranscript(h.claude, "proj", A, [prompt("00", "hi")]);
		writeTranscript(h.claude, "proj", B, [prompt("00", "hi")]);
		ingestPending(db, { config });
		expect(one("SELECT capture, start_reason FROM sessions WHERE session_id = ?", A)).toEqual({
			capture: "backfill",
			start_reason: null,
		});
		addEvent(A, "SessionStart", { session_id: A, hook_event_name: "SessionStart", source: "resume" });
		addEvent(B, "SessionStart", { session_id: B, hook_event_name: "SessionStart", source: "fork" });
		deriveSession(db, A);
		deriveSession(db, B);
		expect(one("SELECT capture, start_reason FROM sessions WHERE session_id = ?", A)).toEqual({
			capture: "hooks",
			start_reason: "resume",
		});
		expect(one("SELECT start_reason FROM sessions WHERE session_id = ?", B).start_reason).toBe("fork");
	});

	it("counts usage when there is no cost-state line", () => {
		writeTranscript(h.claude, "proj", A, [prompt("00", "hi"), reply("01", "m1", "a", 10), reply("02", "m2", "b", 20)]);
		ingestPending(db, { config });
		expect(one("SELECT reported_cost_usd, reported_usage FROM sessions")).toEqual({
			reported_cost_usd: null,
			reported_usage: null,
		});
		const totals = sessionTotals(db, A);
		expect(totals).toMatchObject({ source: "counted", partial: true });
		expect(totals.tokens).toEqual({ inputTokens: 2, outputTokens: 30, cacheCreationTokens: 0, cacheReadTokens: 0 });
		expect(totals.costUsd).toBeCloseTo((2 * 4 + 30 * 20) / 1e6, 12);
	});

	it("excludes a sentinel prompt and its reply from turns, usage and reported cost", () => {
		storeLines(A, [
			prompt("00", "real question"),
			reply("01", "m1", "real answer"),
			prompt("02", "[cc-debrief:summary]\nsummarize"),
			reply("03", "m2", "summary text"),
			prompt("04", "next real question"),
			reply("05", "m3", "answer 2"),
			costState(1),
		]);
		deriveSession(db, A);
		expect(all("SELECT seq, user_text FROM turns ORDER BY seq")).toEqual([
			{ seq: 1, user_text: "real question" },
			{ seq: 2, user_text: "next real question" },
		]);
		expect(all("SELECT message_id FROM usage ORDER BY id").map((r) => r.message_id)).toEqual(["m1", "m3"]);
		expect(one("SELECT reported_cost_usd FROM sessions").reported_cost_usd).toBeNull();
	});

	it("skips non-prompt user lines when building turns", () => {
		const user = (ts: string, content: unknown, extra: object = {}) => ({
			...prompt(ts, ""),
			message: { role: "user", content },
			...extra,
		});
		storeLines(A, [
			prompt("00", "real"),
			user("01", "Base directory for this skill", { isMeta: true }),
			user("02", "<command-name>/model</command-name>"),
			user("03", "<local-command-stdout>ok</local-command-stdout>"),
			user("04", [{ type: "text", text: "[Request interrupted by user for tool use]" }]),
			user("05", "<task-notification>\n<task-id>x</task-id>", { origin: { kind: "task-notification" } }),
			user("06", "This session is being continued", { isCompactSummary: true }),
			user("07", "/compact"),
			user("08", [{ type: "tool_result", tool_use_id: "t", content: "x" }]),
			user("09", [
				{ type: "text", text: "with blocks" },
				{ type: "image", source: {} },
			]),
		]);
		deriveSession(db, A);
		expect(all("SELECT user_text FROM turns ORDER BY seq").map((r) => r.user_text)).toEqual(["real", "with blocks"]);
	});

	it("creates the session from a subagent file when the main transcript is missing", () => {
		writeTranscript(h.claude, "proj", A, [{ ...reply("03", "s1"), isSidechain: true, agentId: "ag" }], {
			agentId: "ag",
		});
		ingestPending(db, { config });
		expect(one("SELECT started_at, ended_at FROM sessions WHERE session_id = ?", A)).toEqual({
			started_at: T("03"),
			ended_at: T("03"),
		});
	});

	it("removes the session's rows once its main transcript is internal", () => {
		writeTranscript(h.claude, "proj", A, [prompt("00", "hi"), reply("01", "m1")]);
		ingestPending(db, { config });
		db.prepare("UPDATE transcripts SET internal = 1 WHERE agent_id IS NULL").run();
		deriveSession(db, A);
		expect(one("SELECT count(*) AS n FROM sessions").n).toBe(0);
		expect(one("SELECT count(*) AS n FROM usage").n).toBe(0);
	});

	it("maps entrypoints to surfaces", () => {
		expect(surfaceFromEntrypoint("cli")).toBe("cli");
		expect(surfaceFromEntrypoint("claude-vscode")).toBe("vscode");
		expect(surfaceFromEntrypoint("claude-desktop")).toBe("desktop");
		expect(surfaceFromEntrypoint("sdk-ts")).toBe("unknown");
		expect(surfaceFromEntrypoint(null)).toBe("unknown");
	});

	it("takes the title from the last ai-title line of a CLI fixture", () => {
		const c = loadFixtureCases().find((x) => x.surface === "cli" && x.caseJson.covers.includes("ai-title"));
		if (!c) throw new Error("no CLI ai-title fixture");
		copyFixtureInto(h.claude, c.caseDir);
		ingestPending(db, { config });
		const title = one("SELECT title FROM sessions WHERE session_id = ?", c.sessionId).title;
		expect(typeof title).toBe("string");
		expect(title).not.toBe("");
	});
});

describe("usage ownership across forks", () => {
	// A has three messages; B is a copy of A's history (same message ids) plus two of its own, and a cost-state
	// line that is cumulative with A's usage.
	function writeForkPair(copiedTs: (ts: string) => string) {
		const history = [
			prompt("00", "q1"),
			reply("01", "m1"),
			prompt("02", "q2"),
			reply("03", "m2"),
			prompt("04", "q3"),
			reply("05", "m3"),
		];
		writeTranscript(h.claude, "proj", A, [...history, costState(0.3)]);
		writeTranscript(h.claude, "proj", B, [
			...history.map((l) => ({ ...l, timestamp: T(copiedTs(l.timestamp.slice(14, 16))) })),
			prompt("20", "q4"),
			reply("21", "m4"),
			prompt("22", "q5"),
			reply("23", "m5"),
			costState(0.5),
		]);
	}
	const owners = () =>
		Object.fromEntries(
			all("SELECT message_id, session_id FROM usage ORDER BY message_id").map((r) => [r.message_id, r.session_id]),
		);
	const reported = (id: string) =>
		one("SELECT reported_cost_usd FROM sessions WHERE session_id = ?", id).reported_cost_usd;

	for (const [label, copiedTs] of [
		["copies with later timestamps", (ts: string) => String(Number(ts) + 10)],
		["copies with the original timestamps", (ts: string) => ts],
	] as const) {
		it(`gives the shared messages to the earlier session (${label}), whatever the ingest order`, () => {
			writeForkPair(copiedTs);
			const calls: string[] = [];
			const derive = (d: Db, id: string) => {
				calls.push(id);
				deriveSession(d, id);
			};
			ingestSession(db, B, { config, derive });
			expect(owners()).toEqual({ m1: B, m2: B, m3: B, m4: B, m5: B });
			ingestSession(db, A, { config, derive });
			expect(calls).toEqual([B, A, B]); // A took the keys over and B was re-derived once
			expect(owners()).toEqual({ m1: A, m2: A, m3: A, m4: B, m5: B });
			expect(reported(A)).toBe(0.3);
			expect(reported(B)).toBeNull();
			expect(sessionTotals(db, B)).toMatchObject({ source: "counted", partial: true });
			expect(getMeta(db, `rederive:${B}`)).toBeNull();

			const byParentFirst = dump();
			db.exec(
				"DELETE FROM usage; DELETE FROM turns; DELETE FROM sessions; DELETE FROM transcript_lines; DELETE FROM transcripts;",
			);
			ingestSession(db, A, { config });
			ingestSession(db, B, { config });
			expect(owners()).toEqual({ m1: A, m2: A, m3: A, m4: B, m5: B });
			expect(reported(B)).toBeNull();
			expect(dump().usage.map((r) => [r.message_id, r.session_id, r.output_tokens])).toEqual(
				byParentFirst.usage.map((r) => [r.message_id, r.session_id, r.output_tokens]),
			);
		});
	}
});

describe("sessionTotals", () => {
	it("counts nothing for a session without usage", () => {
		writeTranscript(h.claude, "proj", A, [prompt("00", "hi")]);
		ingestPending(db, { config });
		expect(sessionTotals(db, A)).toEqual({
			tokens: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
			costUsd: 0,
			source: "counted",
			partial: true,
		});
	});

	it("returns a null cost when every counted row has an unknown model", () => {
		writeTranscript(h.claude, "proj", A, [prompt("00", "hi"), reply("01", "m1", "x", 5, "mystery-model")]);
		ingestPending(db, { config });
		expect(sessionTotals(db, A).costUsd).toBeNull();
	});
});

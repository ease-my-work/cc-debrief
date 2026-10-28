import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSessionContext, sessionCacheShares } from "../../../src/coach/context";
import type { SessionContext } from "../../../src/coach/types";
import type { Db } from "../../../src/db/adapter";
import { encodePayload } from "../../../src/ingest/line";
import { ctx } from "../../helpers/ctx";
import { seedDb } from "../../helpers/seed";
import { REPO_APP, S, seedSmall, seedSmallInventory } from "../../helpers/seed-small";
import { type TmpHome, tmpHome } from "../../helpers/tmp-home";

let t: TmpHome;
let db: Db;
beforeEach(() => {
	t = tmpHome();
	db = seedDb();
});
afterEach(() => {
	db.close();
	t.cleanup();
});

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

describe("loadSessionContext on seed-small", () => {
	beforeEach(() => {
		seedSmall(db);
		seedSmallInventory(db);
		// seed-small leaves usage.turn_id NULL; attribute S1's two rows to its two turns.
		const turnIds = db
			.prepare("SELECT id FROM turns WHERE session_id = ? ORDER BY seq")
			.all<{ id: number }>(S.s1)
			.map((r) => r.id);
		const usageIds = db
			.prepare("SELECT id FROM usage WHERE session_id = ? ORDER BY ts")
			.all<{ id: number }>(S.s1)
			.map((r) => r.id);
		const setTurn = db.prepare("UPDATE usage SET turn_id = ? WHERE id = ?");
		for (const [i, u] of usageIds.entries()) setTurn.run(turnIds[i], u);
		const ev = db.prepare("INSERT INTO events (session_id, event, ts, payload) VALUES (?, 'PermissionRequest', ?, ?)");
		ev.run(S.s1, "2026-10-01T08:01:00.000Z", JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" } }));
		ev.run(S.s1, "2026-10-01T08:00:30.000Z", JSON.stringify({ tool_name: "mcp__github__search_code" }));
		ev.run(S.s2, "2026-10-01T08:02:00.000Z", JSON.stringify({ tool_name: "Bash" }));
	});

	it("has the session's counts, per-turn non-cached tokens and totals", () => {
		const c = loadSessionContext(db, S.s1);
		expect(c.session).toMatchObject({ sessionId: S.s1, repoId: REPO_APP, cwd: "/w/app" });
		expect(c.capture).toBe("hooks");
		expect(c.turns.map((x) => [x.seq, x.userText, x.tokens])).toEqual([
			[1, "Please fix the alembic migration", 350],
			[2, "Run it again", 150],
		]);
		expect(c.toolCalls).toHaveLength(9);
		expect(c.usage).toHaveLength(2);
		expect(c.totals).toEqual({ input: 200, output: 100, cacheCreation: 200, cacheRead: 1500, tokens: 500 });
		expect(c.compactions).toHaveLength(1);
		expect(c.subagents).toEqual([
			{ agentId: "ag1", agentType: "Explore", startedAt: expect.any(String), endedAt: expect.any(String) },
		]);
		expect(c.fileChanges).toHaveLength(4);
		expect(c.inventory.map((i) => [i.kind, i.name, i.loaded, i.invoked]).sort()).toEqual(
			[
				["mcp", "github", true, true],
				["mcp", "tracker", true, false],
				["skill", "code-review", true, true],
				["skill", "demo", true, false],
				["skill", "deploy", true, false],
				["skill", "old-helper", true, false],
				["skill", "superpowers:brainstorming", true, false],
			].sort(),
		);
		expect(c.inventory.find((i) => i.name === "code-review")?.description).toBe("c".repeat(40));
		expect(c.inventory.find((i) => i.name === "github")?.meta).toEqual({ type: "stdio", command: "gh-mcp" });
	});

	it("parses tool call inputs and result columns, with turn seq and agent", () => {
		const c = loadSessionContext(db, S.s1);
		const byId = (n: number) => c.toolCalls[n];
		expect(byId(0)).toMatchObject({
			toolName: "Bash",
			input: { command: "npm test" },
			ok: false,
			denied: null,
			exitCode: 1,
			turnSeq: 1,
			agentId: null,
			responseBytes: 0,
		});
		expect(c.toolCalls.find((x) => x.input.file_path === "/w/app/a.ts")).toMatchObject({
			toolName: "Read",
			agentId: "ag1",
		});
		expect(c.toolCalls.find((x) => x.toolName === "Write")).toMatchObject({ ok: false, denied: "user", turnSeq: 2 });
		expect(c.toolCalls.find((x) => x.toolName.startsWith("mcp__"))).toMatchObject({
			mcpServer: "github",
			mcpTool: "search_code",
		});
		// oldest first
		const starts = c.toolCalls.map((x) => x.startedAt as string);
		expect([...starts].sort()).toEqual(starts);
	});

	it("takes permission requests only from this session's PermissionRequest events, oldest first", () => {
		const c = loadSessionContext(db, S.s1);
		expect(c.permissionRequests).toEqual([
			{ tool: "mcp__github__search_code", at: "2026-10-01T08:00:30.000Z", mcpServer: "github" },
			{ tool: "Bash", at: "2026-10-01T08:01:00.000Z", mcpServer: null },
		]);
	});

	it("reports an imported session's capture", () => {
		expect(loadSessionContext(db, S.s3).capture).toBe("backfill");
	});

	it("throws for an unknown session", () => {
		expect(() => loadSessionContext(db, "nope")).toThrow(/nope/);
	});
});

describe("responseBytes", () => {
	it("uses origBytes, else bytes plus N of a marker visible in a whole-result excerpt, else 0", () => {
		db.prepare("INSERT INTO sessions (session_id, started_at) VALUES ('s', '2026-10-01T10:00:00.000Z')").run();
		const ins = db.prepare(
			"INSERT INTO tool_calls (session_id, tool_use_id, tool_name, input, response, started_at) VALUES ('s', ?, 'Read', ?, ?, ?)",
		);
		const marker = "…[truncated 900 bytes]";
		const small = `${"a".repeat(100)}${marker}`;
		const big = "b".repeat(4096);
		ins.run(
			"t1",
			encodePayload({}),
			encodePayload({ bytes: 9000, origBytes: 20000, excerpt: "x" }),
			"2026-10-01T10:00:01Z",
		);
		ins.run(
			"t2",
			encodePayload({}),
			encodePayload({ bytes: Buffer.byteLength(small), excerpt: small }),
			"2026-10-01T10:00:02Z",
		);
		// A cut excerpt carries its own marker, which says nothing about the stored result.
		ins.run(
			"t3",
			encodePayload({}),
			encodePayload({ bytes: 6000, excerpt: `${big}${marker}` }),
			"2026-10-01T10:00:03Z",
		);
		ins.run("t4", null, null, "2026-10-01T10:00:04Z");
		const c = loadSessionContext(db, "s");
		expect(c.toolCalls.map((x) => x.responseBytes)).toEqual([20000, 100 + 900, 6000, 0]);
		expect(c.toolCalls[3].input).toEqual({});
	});
});

describe("userMedianCacheShare", () => {
	const START = Date.parse("2026-10-01T10:00:00.000Z");
	let n = 0;
	const session = (startMs: number, share: number | null) => {
		const id = `p${++n}`;
		db.prepare("INSERT INTO sessions (session_id, started_at, ended_at) VALUES (?, ?, ?)").run(
			id,
			iso(startMs),
			iso(startMs + 600_000),
		);
		if (share !== null) {
			// input-side 1000 tokens with `share` of them cache reads
			db.prepare(
				"INSERT INTO usage (session_id, input_tokens, cache_creation_tokens, cache_read_tokens, output_tokens, ts) VALUES (?, ?, 0, ?, 99, ?)",
			).run(id, 1000 - Math.round(share * 1000), Math.round(share * 1000), iso(startMs));
		}
		return id;
	};

	beforeEach(() => {
		n = 0;
		session(START, 0.5); // p1: the session under test
		session(START - 40 * DAY, 0.1); // older than 30 days
		session(START + DAY, 0.1); // after it
		session(START - DAY, null); // no usage rows
	});

	it("is null with 4 prior sessions", () => {
		for (const s of [0.6, 0.7, 0.8, 0.9]) session(START - 2 * DAY, s);
		expect(loadSessionContext(db, "p1").userMedianCacheShare).toBeNull();
	});

	it("is the middle share with 5 and the mean of the middle two with 6", () => {
		for (const s of [0.6, 0.7, 0.8, 0.9, 0.2]) session(START - 2 * DAY, s);
		expect(loadSessionContext(db, "p1").userMedianCacheShare).toBeCloseTo(0.7, 6);
		session(START - 3 * DAY, 0.95);
		expect(loadSessionContext(db, "p1").userMedianCacheShare).toBeCloseTo(0.75, 6);
	});

	it("gives the same median from a precomputed share list", () => {
		for (const s of [0.6, 0.7, 0.8, 0.9, 0.2]) session(START - 2 * DAY, s);
		const shares = sessionCacheShares(db, iso(START - 90 * DAY), "9999");
		expect(shares.length).toBe(8); // all sessions with usage, p1 and the out-of-window ones included
		expect(loadSessionContext(db, "p1", { shares }).userMedianCacheShare).toBeCloseTo(0.7, 6);
	});
});

describe("ctx() builder", () => {
	it("returns a SessionContext with non-cached tokens and totals from its usage rows", () => {
		const c: SessionContext = ctx();
		expect(c.turns).toHaveLength(10);
		expect(c.turns[0].tokens).toBe(150);
		expect(c.totals).toEqual({ input: 1000, output: 500, cacheCreation: 0, cacheRead: 3000, tokens: 1500 });
		expect(c.capture).toBe("hooks");
		expect(c.userMedianCacheShare).toBeNull();
	});
});

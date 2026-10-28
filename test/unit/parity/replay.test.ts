// Phase 7 Task 10 (P8): getReplay() — per-turn reply, tokens, cost, tools, failures, compactions, cumulative tokens.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../../../src/db/adapter";
import { migrate } from "../../../src/db/migrate";
import { getReplay } from "../../../src/db/queries/replay";
import { totalsFor } from "../../../src/db/queries/totals";
import { encodePayload } from "../../../src/ingest/line";

let db: Db;
beforeEach(() => {
	db = openDb(":memory:");
	migrate(db);
	seed();
});
afterEach(() => db.close());

const T = (m: number) => new Date(Date.UTC(2026, 9, 1, 10, m)).toISOString();
const CUT = `${"x".repeat(100)}…[truncated 4096 bytes]`;

function seed() {
	db.prepare("INSERT INTO sessions (session_id, started_at, ended_at) VALUES ('s', ?, ?)").run(T(0), T(30));
	const turn = db.prepare(
		"INSERT INTO turns (session_id, seq, user_text, assistant_text, started_at) VALUES ('s', ?, ?, ?, ?)",
	);
	const t1 = Number(turn.run(1, "first ask", "**done** one", T(0)).lastInsertRowid);
	const t2 = Number(turn.run(2, "second ask", CUT, T(10)).lastInsertRowid);
	const t3 = Number(turn.run(3, "third ask", null, T(20)).lastInsertRowid);
	const usage = db.prepare(
		`INSERT INTO usage (session_id, agent_id, turn_id, model, input_tokens, output_tokens, cache_creation_tokens,
		   cache_read_tokens, cost_usd, ts) VALUES ('s', ?, ?, 'claude-sonnet-4-5', ?, ?, ?, ?, ?, ?)`,
	);
	usage.run(null, null, 5, 0, 0, 0, 0.001, T(0)); // before the first turn: counted on turn 1
	usage.run(null, t1, 100, 10, 20, 300, 0.01, T(1));
	usage.run(null, t2, 200, 20, 0, 400, 0.02, T(11));
	usage.run("agent-1", t2, 50, 5, 0, 0, 0.005, T(12)); // a subagent spawned by turn 2
	usage.run(null, t3, 10, 1, 0, 0, null, T(21));
	const call = db.prepare(
		`INSERT INTO tool_calls (session_id, agent_id, turn_id, tool_name, input, ok, denied, started_at)
		 VALUES ('s', ?, ?, ?, ?, ?, ?, ?)`,
	);
	call.run(null, t1, "Read", null, 1, null, T(1));
	call.run(null, t2, "Bash", encodePayload({ command: "npm test" }), 0, null, T(11));
	call.run(null, t2, "Bash", encodePayload({ command: "npm test" }), 1, null, T(12));
	call.run(null, t2, "Edit", null, 0, "user", T(13)); // denied: not a failure
	db.prepare("INSERT INTO compactions (session_id, ts, trigger) VALUES ('s', ?, 'auto')").run(T(15));
}

describe("getReplay", () => {
	it("is null for an unknown session", () => {
		expect(getReplay(db, "nope")).toBeNull();
	});

	it("gives each turn its full reply, tokens, cost, tools and failures", () => {
		const r = getReplay(db, "s");
		expect(r?.turns.map((t) => t.seq)).toEqual([1, 2, 3]);
		const [one, two, three] = r?.turns ?? [];
		expect(one).toMatchObject({
			userText: "first ask",
			assistantText: "**done** one",
			truncated: false,
			tokens: { input: 105, cacheWrite: 20, cacheRead: 300, output: 10 },
			costUsd: 0.011,
			tools: [{ label: "Read", count: 1, failures: 0 }],
			failures: 0,
			compaction: false,
		});
		expect(two.tools).toEqual([
			{ label: "Bash npm", count: 2, failures: 1 },
			{ label: "Edit", count: 1, failures: 0 },
		]);
		expect(two.failures).toBe(1);
		expect(three).toMatchObject({ assistantText: "", costUsd: null });
	});

	it("marks a reply cut at 32 KB", () => {
		expect(getReplay(db, "s")?.turns[1].truncated).toBe(true);
	});

	it("puts subagent usage on the spawning turn", () => {
		expect(getReplay(db, "s")?.turns[1].tokens).toEqual({ input: 250, cacheWrite: 0, cacheRead: 400, output: 25 });
	});

	it("attaches a compaction to the turn after it", () => {
		expect(getReplay(db, "s")?.turns.map((t) => t.compaction)).toEqual([false, false, true]);
	});

	it("per-turn tokens sum to the session's counted total; cumulative runs to it", () => {
		const r = getReplay(db, "s");
		const total = totalsFor(db, "?", ["s"]).get("s")?.tokens;
		const sum = (r?.turns ?? []).reduce(
			(n, t) => n + t.tokens.input + t.tokens.cacheWrite + t.tokens.cacheRead + t.tokens.output,
			0,
		);
		expect(sum).toBe(total);
		expect(r?.cumulative.at(-1)).toBe(total);
		expect(r?.cumulative).toHaveLength(3);
	});
});

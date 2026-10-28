// Phase 6 Task 4: session-day rows and per-day file churn.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../../src/db/adapter";
import { RECAP_ROWS_SQL, recapFiles, recapReads, recapRows } from "../../../src/db/queries/recap";
import { rangeBounds } from "../../../src/recap/range";
import { RECAP_DAY, RECAP_PREV, seedRecapFixture } from "../../helpers/recap-seed";
import { seedDb } from "../../helpers/seed";
import { type TmpHome, tmpHome } from "../../helpers/tmp-home";

let h: TmpHome;
let db: Db;
beforeEach(() => {
	h = tmpHome();
	db = seedDb();
	seedRecapFixture(db);
});
afterEach(() => {
	db.close();
	h.cleanup();
});

const both = rangeBounds({ from: RECAP_PREV, to: RECAP_DAY });
const rows = (b = both) => recapRows(db, b.fromIso, b.toIso);

describe("recapRows", () => {
	it("one row per session per local day, turns counted per day", () => {
		const spanning = rows().filter((r) => r.sessionId === "spanning");
		expect(spanning.map((r) => [r.day, r.turns])).toEqual([
			[RECAP_PREV, 1],
			[RECAP_DAY, 2],
		]);
		expect(spanning[1].firstTurnAt).toBe(new Date(2026, 8, 28, 0, 10).toISOString());
	});

	it("leaves out a session with one turn and no file changes", () => {
		const ids = rows().map((r) => r.sessionId);
		expect(ids).not.toContain("one-turn");
		expect(new Set(ids)).toEqual(
			new Set([
				"titled",
				"summary-only",
				"agent-only",
				"files-only",
				"dup-a",
				"dup-b",
				"read-only",
				"spanning",
				"no-repo",
				"secret",
			]),
		);
	});

	it("carries the session and repo fields, ordered by first turn", () => {
		const r = rows(rangeBounds({ from: RECAP_DAY, to: RECAP_DAY }));
		expect(r[0].sessionId).toBe("spanning");
		const t = r.find((x) => x.sessionId === "titled");
		expect(t).toMatchObject({
			repoId: "github.com/acme/api-gateway",
			repoName: "api-gateway",
			rootPath: "/home/u/code/api-gateway",
			title: "Add rate limiting to the public endpoints",
			summary: "Added a limiter. Also tests.",
			agentName: null,
			day: RECAP_DAY,
			turns: 3,
		});
		expect(r.find((x) => x.sessionId === "no-repo")).toMatchObject({
			repoId: null,
			repoName: null,
			cwd: "/tmp/scratch",
		});
		const firsts = r.map((x) => x.firstTurnAt);
		expect(firsts).toEqual([...firsts].sort());
	});

	it("leaves out the tracker's own claude -p sessions", () => {
		db.prepare("INSERT INTO ai_calls (feature, session_id, ts) VALUES ('summary', 'summary-only', ?)").run(
			both.fromIso,
		);
		expect(rows().map((r) => r.sessionId)).not.toContain("summary-only");
	});

	it("an empty range has no rows", () => {
		expect(rows(rangeBounds({ from: "2026-01-01", to: "2026-01-02" }))).toEqual([]);
	});

	it("never returns prompt text", () => {
		expect(JSON.stringify(rows())).not.toContain("LEAKTOKEN");
	});

	it("uses the turns_started_at index", () => {
		const plan = db
			.prepare(`EXPLAIN QUERY PLAN ${RECAP_ROWS_SQL}`)
			.all<{ detail: string }>(both.fromIso, both.toIso)
			.map((p) => p.detail)
			.join("\n");
		expect(plan).toContain("turns_started_at");
	});
});

describe("recapRows turn times and recapReads", () => {
	it("each session-day row carries its turn start times", () => {
		const spanning = rows().filter((r) => r.sessionId === "spanning");
		expect(spanning.map((r) => r.turnTimes)).toEqual([
			[new Date(2026, 8, 27, 23, 30).toISOString()],
			[new Date(2026, 8, 28, 0, 10).toISOString(), new Date(2026, 8, 28, 0, 40).toISOString()],
		]);
	});

	it("Read calls per session, day and full path, with a count", () => {
		expect(recapReads(db, ["read-only", "titled"], both.fromIso, both.toIso)).toEqual([
			{ sessionId: "read-only", day: RECAP_DAY, path: "/home/u/notes/README.md", count: 3 },
			{ sessionId: "read-only", day: RECAP_DAY, path: "/home/u/notes/plan.md", count: 2 },
			{ sessionId: "read-only", day: RECAP_DAY, path: "/home/u/notes/docs/todo.md", count: 1 },
		]);
		expect(recapReads(db, [], both.fromIso, both.toIso)).toEqual([]);
		const prev = rangeBounds({ from: RECAP_PREV, to: RECAP_PREV });
		expect(recapReads(db, ["read-only"], prev.fromIso, prev.toIso)).toEqual([]);
	});
});

describe("recapFiles", () => {
	it("splits a spanning session's files by the tool call's day, with the full path and churn", () => {
		expect(recapFiles(db, ["spanning"], both.fromIso, both.toIso)).toEqual([
			{
				sessionId: "spanning",
				day: RECAP_PREV,
				path: "/home/u/notes/.claude/worktrees/fix-x/export.ts",
				repoId: "/home/u/notes/.claude/worktrees/fix-x",
				churn: 9,
			},
			{
				sessionId: "spanning",
				day: RECAP_DAY,
				path: "/home/u/notes/.claude/worktrees/fix-x/export.test.ts",
				repoId: "/home/u/notes/.claude/worktrees/fix-x",
				churn: 4,
			},
		]);
	});

	it("only the given sessions and only edits inside the range", () => {
		const day = rangeBounds({ from: RECAP_DAY, to: RECAP_DAY });
		const f = recapFiles(db, ["spanning", "titled"], day.fromIso, day.toIso);
		expect(new Set(f.map((x) => x.sessionId))).toEqual(new Set(["spanning", "titled"]));
		expect(f.some((x) => x.path.endsWith("export.ts"))).toBe(false);
		expect(recapFiles(db, [], day.fromIso, day.toIso)).toEqual([]);
	});

	it("sums churn per path and day", () => {
		db.prepare(
			"INSERT INTO file_changes (session_id, tool_call_id, repo_id, path, lines_added, lines_removed) SELECT session_id, tool_call_id, repo_id, path, 1, 1 FROM file_changes WHERE path LIKE '%errors.go'",
		).run();
		const f = recapFiles(db, ["titled"], both.fromIso, both.toIso).find((x) => x.path.endsWith("errors.go"));
		expect(f?.churn).toBe(42);
	});
});

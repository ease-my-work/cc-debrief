import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { estimateCost } from "../../src/collector/prices";
import {
	buildStoredTurnsPrompt,
	buildSummaryPrompt,
	estimateSummaryCost,
	heuristicType,
	SUMMARY_JSON_SCHEMA,
	SummaryResultSchema,
} from "../../src/collector/summarize";
import { type Config, ConfigSchema } from "../../src/config";
import type { Db } from "../../src/db/adapter";
import { encodePayload } from "../../src/ingest/line";
import { seedDb, storeLines } from "../helpers/seed";
import { type TmpHome, tmpHome } from "../helpers/tmp-home";

const cfg = (ai: Partial<Config["ai"]> = {}): Config => {
	const c = ConfigSchema.parse({});
	return { ...c, ai: { ...c.ai, ...ai } };
};
const calls = (...spec: [string, string?][]) => spec.map(([tool_name, path]) => ({ tool_name, path: path ?? null }));

describe("heuristicType", () => {
	it("only .md edits → docs", () => {
		expect(heuristicType(calls(["Read", "a.ts"], ["Edit", "README.md"], ["Write", "docs/guide.md"]))).toBe("docs");
	});
	it("mostly edits, mostly on test files → bugfix", () => {
		expect(
			heuristicType(
				calls(
					["Edit", "tests/a.py"],
					["Edit", "src/__tests__/b.ts"],
					["Edit", "src/c.test.ts"],
					["Edit", "src/c.ts"],
					["Read", "src/c.ts"],
				),
			),
		).toBe("bugfix");
	});
	it("test-file edits that are not the majority of calls → not bugfix", () => {
		expect(
			heuristicType(calls(["Edit", "tests/a.py"], ["Edit", "tests/b.py"], ["Bash"], ["Bash"], ["Bash"], ["Bash"])),
		).toBe("other");
	});
	it("mostly Read / Grep / Glob → exploration", () => {
		expect(heuristicType(calls(["Read", "a"], ["Grep"], ["Glob"], ["Edit", "src/x.ts"]))).toBe("exploration");
	});
	it("mixed → other; no calls → other", () => {
		expect(heuristicType(calls(["Read", "a"], ["Bash"], ["Edit", "src/x.ts"], ["Bash"]))).toBe("other");
		expect(heuristicType([])).toBe("other");
	});
	it("recognises test names and Windows paths", () => {
		expect(
			heuristicType(calls(["Edit", "C:\\w\\app\\test\\a.ts"], ["Edit", "pkg/test_util.py"], ["Edit", "x_test.go"])),
		).toBe("bugfix");
	});
});

describe("SummaryResultSchema", () => {
	const valid = {
		summary: "Fixed the login bug. Tests pass.",
		session_type: "bugfix",
		tags: ["auth"],
		outcome: "completed",
	};
	it("accepts a valid object and ignores extra keys", () => {
		expect(SummaryResultSchema.parse({ ...valid, extra: 1 })).toEqual(valid);
	});
	it("rejects an unknown session_type, outcome or an empty summary", () => {
		expect(SummaryResultSchema.safeParse({ ...valid, session_type: "research" }).success).toBe(false);
		expect(SummaryResultSchema.safeParse({ ...valid, outcome: "done" }).success).toBe(false);
		expect(SummaryResultSchema.safeParse({ ...valid, summary: "  " }).success).toBe(false);
	});
	it("keeps at most 5 tags", () => {
		expect(SummaryResultSchema.parse({ ...valid, tags: ["a", "b", "c", "d", "e", "f"] }).tags).toHaveLength(5);
	});
	it("the JSON Schema lists the same enums and fields", () => {
		const s = SUMMARY_JSON_SCHEMA as unknown as { required: string[]; properties: Record<string, { enum?: string[] }> };
		expect(s.required.sort()).toEqual(["outcome", "session_type", "summary", "tags"]);
		expect(s.properties.session_type.enum).toEqual([
			"feature",
			"bugfix",
			"refactor",
			"exploration",
			"ops",
			"docs",
			"other",
		]);
		expect(s.properties.outcome.enum).toEqual(["completed", "partial", "abandoned", "unclear"]);
	});
});

describe("buildSummaryPrompt", () => {
	it("asks for the schema fields about the transcript below", () => {
		const p = buildSummaryPrompt();
		expect(p).toMatch(/2.4 sentences/);
		expect(p).toContain("feature, bugfix, refactor, exploration, ops, docs, other");
		expect(p).toMatch(/up to 5/i);
		expect(p).toContain("completed, partial, abandoned or unclear");
		expect(p).toMatch(/below/);
		expect(p).not.toContain("[cc-debrief:"); // runClaude adds the sentinel
	});
});

describe("with a DB", () => {
	let h: TmpHome;
	let db: Db;
	const SID = "s-1";
	beforeEach(() => {
		h = tmpHome();
		db = seedDb();
	});
	afterEach(() => {
		db.close();
		h.cleanup();
	});

	function seedTurns(n: number, textSize = 20) {
		db.prepare("INSERT INTO sessions (session_id, started_at) VALUES (?, '2026-10-01T10:00:00Z')").run(SID);
		for (let i = 0; i < n; i++) {
			const turnId = Number(
				db
					.prepare("INSERT INTO turns (session_id, seq, user_text, assistant_text) VALUES (?, ?, ?, ?)")
					.run(SID, i, `prompt ${i} ${"p".repeat(textSize)}`, `answer ${i} ${"a".repeat(textSize)}`).lastInsertRowid,
			);
			const tool = db.prepare(
				"INSERT INTO tool_calls (session_id, turn_id, tool_name, input, ok, started_at) VALUES (?, ?, ?, ?, ?, ?)",
			);
			tool.run(SID, turnId, "Read", encodePayload({ file_path: "src/a.ts" }), 1, `2026-10-01T10:0${i}:01Z`);
			tool.run(SID, turnId, "Read", encodePayload({ file_path: "src/b.ts" }), 1, `2026-10-01T10:0${i}:02Z`);
			tool.run(SID, turnId, "Read", encodePayload({ file_path: "src/c.ts" }), 1, `2026-10-01T10:0${i}:03Z`);
			tool.run(SID, turnId, "Edit", encodePayload({ file_path: "src/a.ts" }), 1, `2026-10-01T10:0${i}:04Z`);
			tool.run(SID, turnId, "Bash", encodePayload({ command: "npm test" }), 0, `2026-10-01T10:0${i}:05Z`);
		}
		storeLines(db, SID, [{ type: "user", uuid: "u1", message: { content: "RAW_LINE_MARKER" } }]);
	}

	it("buildStoredTurnsPrompt lists each turn's prompt, tool skeleton and reply excerpt in order", () => {
		seedTurns(3);
		const p = buildStoredTurnsPrompt(db, SID);
		const at = (s: string) => p.indexOf(s);
		expect(at("You: prompt 0")).toBeGreaterThan(-1);
		expect(at("You: prompt 0")).toBeLessThan(at("You: prompt 1"));
		expect(at("You: prompt 1")).toBeLessThan(at("You: prompt 2"));
		expect(p).toContain("Tools: Read ×3, Edit src/a.ts, Bash npm test (failed)");
		expect(p).toContain("Claude: answer 2");
		expect(p).not.toContain("RAW_LINE_MARKER");
		expect(p).not.toContain("omitted");
	});

	it("buildStoredTurnsPrompt trims the oldest turns first to fit maxChars and keeps the latest", () => {
		seedTurns(6, 80);
		const p = buildStoredTurnsPrompt(db, SID, 500);
		expect(p.length).toBeLessThanOrEqual(500);
		expect(p).toMatch(/\[… \d+ earlier turns omitted\]/);
		expect(p).toContain("You: prompt 5");
		expect(p).not.toContain("You: prompt 0");
	});

	function summaryCall(usd: number, i: number) {
		db.prepare("INSERT INTO self_usage (feature, session_id, cost_usd, ts) VALUES ('summary', ?, ?, ?)").run(
			`f-${i}`,
			usd,
			`2026-10-01T10:00:0${i}Z`,
		);
	}

	it("estimateSummaryCost is the mean of the recent summary calls once there are 3", () => {
		[0.01, 0.02, 0.03, 0.04, 0.05].forEach(summaryCall);
		db.prepare(
			"INSERT INTO self_usage (feature, session_id, cost_usd, ts) VALUES ('review', 'r', 9, '2026-10-01T10:00:00Z')",
		).run();
		expect(estimateSummaryCost(db, cfg())).toBeCloseTo(0.03, 9);
	});

	it("estimateSummaryCost with fewer than 3 calls prices 8,000 in / 400 out on ai.model", () => {
		summaryCall(0.5, 0);
		const sonnet = estimateCost({
			model: "claude-sonnet-5-5",
			inputTokens: 8000,
			outputTokens: 400,
			cacheCreationTokens: 0,
			cacheCreation1hTokens: 0,
			cacheReadTokens: 0,
		});
		expect(estimateSummaryCost(db, cfg({ model: "sonnet" }))).toBeCloseTo(sonnet as number, 9);
		expect(sonnet).toBeCloseTo(0.02, 9);
	});

	it("estimateSummaryCost falls back to the user's most-used model", () => {
		db.prepare("INSERT INTO sessions (session_id) VALUES ('u')").run();
		db.prepare(
			"INSERT INTO usage (session_id, model) VALUES ('u', 'claude-haiku-4-5'), ('u', 'claude-haiku-4-5'), ('u', 'claude-opus-4-1')",
		).run();
		expect(estimateSummaryCost(db, cfg())).toBeCloseTo((8000 * 1 + 400 * 5) / 1e6, 9);
	});

	it("estimateSummaryCost is null with no calls and no known model", () => {
		expect(estimateSummaryCost(db, cfg())).toBeNull();
		expect(estimateSummaryCost(db, cfg({ model: "mystery-model" }))).toBeNull();
	});
});

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeError, callTranscriptsDir, projectFolderName, runClaude } from "../../src/claude/headless";
import type { Db } from "../../src/db/adapter";
import { type FakeClaude, fakeClaude, successResult } from "../helpers/fake-claude";
import { seedDb } from "../helpers/seed";
import { type TmpHome, tmpHome } from "../helpers/tmp-home";

const SCHEMA = { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] };
const fixture = (name: string) =>
	JSON.parse(readFileSync(join(import.meta.dirname, "../fixtures/headless", name), "utf8")).result;

let h: TmpHome;
let db: Db;
let fake: FakeClaude;
let restore: () => void;
beforeEach(() => {
	h = tmpHome();
	db = seedDb();
	fake = fakeClaude(h.home);
	restore = fake.install();
});
afterEach(() => {
	restore();
	db.close();
	h.cleanup();
});

const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
const call = (over: Partial<Parameters<typeof runClaude>[0]> = {}) =>
	runClaude<{ summary: string }>({ prompt: "Summarize.", schema: SCHEMA, feature: "summary", db, ...over });
async function failure(p: Promise<unknown>): Promise<ClaudeError> {
	try {
		await p;
	} catch (e) {
		expect(e).toBeInstanceOf(ClaudeError);
		return e as ClaudeError;
	}
	throw new Error("expected a ClaudeError");
}

describe("runClaude", () => {
	it("parses the Phase 0 result fixture and records one ai_calls row before and one self_usage row after", async () => {
		const warm = fixture("resume-fork-warm.json");
		fake.scenario({ stdout: { ...warm, structured_output: { summary: "ok" } } });
		const r = await call({ targetSessionId: "target-1" });
		expect(r.result).toEqual({ summary: "ok" });
		expect(r.sessionId).toBe("1ab4fc38-bbf3-45e5-8b5b-f51b3e3d1fae");
		expect(r.usage).toEqual({ inputTokens: 10, outputTokens: 92, cacheCreationTokens: 1531, cacheReadTokens: 49643 });
		expect(r.model).toBe("claude-haiku-4-5-20251001");
		// Own usage x haiku 4.5 price (1-hour cache writes at 2x input), not the cumulative 0.109 reported.
		expect(r.costUsd).toBeCloseTo((10 * 1 + 92 * 5 + 1531 * 2 + 49643 * 0.1) / 1e6, 9);
		expect(r.rawTotalCostUsd).toBeCloseTo(0.1089855, 7);
		expect(db.prepare("SELECT feature, session_id, target_session_id FROM ai_calls").all()).toEqual([
			{ feature: "summary", session_id: r.sessionId, target_session_id: "target-1" },
		]);
		const row = db.prepare("SELECT * FROM self_usage").get() as Record<string, number | string>;
		expect(row).toMatchObject({ feature: "summary", session_id: r.sessionId, target_session_id: "target-1" });
		expect(row.cost_usd).toBeCloseTo(r.costUsd as number, 9);
		expect(row.raw_total_cost_usd).toBeCloseTo(0.1089855, 7);
		expect(row.raw_total_cost_usd as number).toBeGreaterThan(10 * (row.cost_usd as number));
	});

	it("passes -p, json output, the schema, no tools and no MCP servers, the budget, and no --model by default", async () => {
		await call();
		const [inv] = fake.invocations();
		expect(inv.argv).toEqual([
			"-p",
			"--output-format",
			"json",
			"--json-schema",
			JSON.stringify(SCHEMA),
			"--tools",
			"",
			"--strict-mcp-config",
			"--max-budget-usd",
			"0.50",
		]);
	});

	it("adds --model when asked and never resumes", async () => {
		await call({ model: "haiku" });
		const [inv] = fake.invocations();
		expect(inv.argv.slice(10)).toEqual(["--model", "haiku"]);
		expect(inv.argv).not.toContain("--resume");
		expect(inv.argv).not.toContain("--fork-session");
	});

	it("marks the child internal and sends the sentinel and prompt on stdin", async () => {
		await call({ prompt: "Summarize this session." });
		const [inv] = fake.invocations();
		expect(inv.env).toEqual({ CC_DEBRIEF_INTERNAL: "1", CC_DEBRIEF_FEATURE: "summary" });
		expect(inv.stdin).toBe("[cc-debrief:summary]\nSummarize this session.");
	});

	it("prices a pinned alias with the model the result reports", async () => {
		const r = await call({ model: "haiku" });
		expect(r.model).toBe("claude-haiku-4-5-20251001");
		expect(r.costUsd).not.toBeNull();
	});

	it("takes the model with the most output from modelUsage", async () => {
		fake.scenario({
			stdout: successResult(undefined, {
				modelUsage: { "claude-haiku-4-5": { outputTokens: 5 }, "claude-sonnet-4-5": { outputTokens: 9999 } },
			}),
		});
		expect((await call()).model).toBe("claude-sonnet-4-5");
	});

	it("a budget error: reason budget, and the cost comes from modelUsage when usage is all zeros (probe B)", async () => {
		fake.scenario({
			stdout: successResult(undefined, {
				is_error: true,
				subtype: "error_max_budget_usd",
				result: undefined,
				structured_output: undefined,
				usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
				modelUsage: {
					"claude-haiku-4-5-20251001": {
						inputTokens: 18,
						outputTokens: 230,
						cacheReadInputTokens: 26309,
						cacheCreationInputTokens: 55556,
					},
				},
			}),
		});
		const e = await failure(call());
		expect(e.reason).toBe("budget");
		const row = db.prepare("SELECT input_tokens, cache_creation_tokens, cost_usd FROM self_usage").get() as Record<
			string,
			number
		>;
		expect(row.input_tokens).toBe(18);
		expect(row.cache_creation_tokens).toBe(55556);
		// haiku 4.5: input 1, output 5, 1-hour cache write 2, cache read 0.1 per million
		expect(row.cost_usd).toBeCloseTo((18 * 1 + 230 * 5 + 55556 * 2 + 26309 * 0.1) / 1e6, 9);
	});

	it("deletes the transcript and session folder the call left in the tracker's projects folder, nothing else", async () => {
		const dir = callTranscriptsDir();
		mkdirSync(join(dir, "call-1", "subagents"), { recursive: true });
		writeFileSync(join(dir, "call-1.jsonl"), "{}");
		writeFileSync(join(dir, "other.jsonl"), "{}");
		fake.scenario({ stdout: successResult(undefined, { session_id: "call-1" }) });
		await call();
		expect(existsSync(join(dir, "call-1.jsonl"))).toBe(false);
		expect(existsSync(join(dir, "call-1"))).toBe(false);
		expect(existsSync(join(dir, "other.jsonl"))).toBe(true);
	});

	it("names the projects folder as Claude Code does", () => {
		expect(projectFolderName("C:\\Users\\X1\\.cc-debrief")).toBe("C--Users-X1--cc-debrief");
		expect(projectFolderName("/home/a_b/.cc-debrief")).toBe("-home-a-b--cc-debrief");
	});

	it("falls back to the result text when structured_output is absent", async () => {
		fake.scenario({ stdout: successResult(undefined, { structured_output: undefined, result: '{"summary":"txt"}' }) });
		expect((await call()).result).toEqual({ summary: "txt" });
	});

	it("exit code 1: exit error, ai_calls row kept, no self_usage row", async () => {
		fake.scenario({ exitCode: 1, stderr: "boom" });
		const e = await failure(call());
		expect(e.reason).toBe("exit");
		expect(e.message).toContain("1");
		expect(count("SELECT count(*) AS n FROM ai_calls")).toBe(1);
		expect(count("SELECT count(*) AS n FROM self_usage")).toBe(0);
	});

	it("stdout that is not JSON: parse error", async () => {
		fake.scenario({ stdout: "Error: something" });
		expect((await failure(call())).reason).toBe("parse");
		expect(count("SELECT count(*) AS n FROM self_usage")).toBe(0);
	});

	it("a result without a structured object: schema error, but the call's usage is still recorded", async () => {
		fake.scenario({ stdout: successResult(undefined, { structured_output: undefined, result: "plain words" }) });
		expect((await failure(call())).reason).toBe("schema");
		expect(count("SELECT count(*) AS n FROM self_usage")).toBe(1);
	});

	it("an is_error result: exit error with Claude Code's message", async () => {
		fake.scenario({
			stdout: successResult(undefined, {
				is_error: true,
				subtype: "error_during_execution",
				result: "No conversation found",
			}),
		});
		const e = await failure(call());
		expect(e.reason).toBe("exit");
		expect(e.message).toContain("No conversation found");
	});

	it("a call slower than the timeout: timeout error", async () => {
		fake.scenario({ delayMs: 20_000, stdout: successResult() });
		expect((await failure(call({ timeoutMs: 500 }))).reason).toBe("timeout");
		expect(count("SELECT count(*) AS n FROM ai_calls")).toBe(1);
	});

	it("with a cap: reserves the ai_calls row only below today's count, else capped without a spawn", async () => {
		const now = new Date();
		await call({ cap: 2, now });
		await call({ cap: 2, now });
		expect((await failure(call({ cap: 2, now }))).reason).toBe("capped");
		expect(fake.invocations()).toHaveLength(2);
		expect(count("SELECT count(*) AS n FROM ai_calls")).toBe(2);
		// other features have their own count; yesterday's rows do not count
		await call({ cap: 2, now, feature: "review" });
		db.prepare("UPDATE ai_calls SET ts = ?").run(new Date(now.getTime() - 2 * 86_400_000).toISOString());
		await call({ cap: 2, now });
		expect(fake.invocations()).toHaveLength(4);
	});

	it("claude not on PATH: not_found", async () => {
		restore();
		const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
		const saved = process.env[pathKey];
		process.env[pathKey] = join(h.home, "empty-bin");
		try {
			expect((await failure(call())).reason).toBe("not_found");
		} finally {
			process.env[pathKey] = saved;
			restore = fake.install();
		}
	});

	it("keeps a schema with quotes, spaces and shell characters intact on the command line", async () => {
		const schema = {
			type: "object",
			description: 'a "quoted" value & more | <x> %PATH% ^caret',
			properties: { summary: { type: "string", description: "two words" } },
		};
		await call({ schema });
		expect(JSON.parse(fake.invocations()[0].argv[4])).toEqual(schema);
	});
});

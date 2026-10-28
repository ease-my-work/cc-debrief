import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pendingSummaryIds, summarizeSession, summarizeSessionResult } from "../../src/collector/summarize";
import { type Config, ConfigSchema } from "../../src/config";
import type { Db } from "../../src/db/adapter";
import { FAKE_SUMMARY, type FakeClaude, fakeClaude, successResult } from "../helpers/fake-claude";
import { seedDb } from "../helpers/seed";
import { HOUR, type SummarySeed, seedSummarizable } from "../helpers/seed-summary";
import { type TmpHome, tmpHome } from "../helpers/tmp-home";

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

const cfg = (ai: Partial<Config["ai"]> = {}): Config => {
	const c = ConfigSchema.parse({});
	return { ...c, ai: { ...c.ai, ...ai } };
};

const seedSession = (id: string, s: SummarySeed = {}) => seedSummarizable(db, h.claude, id, s);
const row = (id: string) =>
	db
		.prepare(
			"SELECT summary, session_type, type_source, outcome, tags, summary_error FROM sessions WHERE session_id = ?",
		)
		.get(id) as Record<string, string | null>;
const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
const spawns = () => fake.invocations().length;

describe("summarizeSession", () => {
	it("summarizes an ended hook-captured session with 3 turns from its stored turns", async () => {
		seedSession("s1");
		const r = await summarizeSessionResult(db, "s1", cfg());
		expect(r.status).toBe("done");
		expect(r.costUsd).toBeGreaterThan(0);
		expect(row("s1")).toEqual({
			summary: FAKE_SUMMARY.summary,
			session_type: "feature",
			type_source: "ai",
			outcome: "completed",
			tags: JSON.stringify(FAKE_SUMMARY.tags),
			summary_error: null,
		});
		expect(db.prepare("SELECT feature, target_session_id FROM self_usage").all()).toEqual([
			{ feature: "summary", target_session_id: "s1" },
		]);
		const [inv] = fake.invocations();
		// Stored turns even though the transcript file is present (review 2026-10-10): never --resume.
		expect(inv.argv).not.toContain("--resume");
		expect(inv.stdin).toMatch(/transcript below/);
		expect(inv.stdin).toContain("You: please do step 0");
		expect(count("SELECT count(*) AS n FROM sessions")).toBe(1); // no row for the call itself
	});

	it("skips a 1-turn session and gives it a heuristic type", async () => {
		seedSession("s1", { turns: 1 });
		expect(await summarizeSession(db, "s1", cfg())).toBe("skipped");
		expect(row("s1")).toMatchObject({ session_type: "exploration", type_source: "heuristic", summary: null });
		expect(spawns()).toBe(0);
	});

	it("skips a session that already has an AI summary, without a spawn", async () => {
		seedSession("s1", { typeSource: "ai" });
		expect(await summarizeSession(db, "s1", cfg())).toBe("skipped");
		expect(spawns()).toBe(0);
	});

	it("skips an imported session unless the request is explicit", async () => {
		seedSession("s1", { capture: "backfill" });
		expect(await summarizeSession(db, "s1", cfg())).toBe("skipped");
		expect(spawns()).toBe(0);
		expect(await summarizeSession(db, "s1", cfg(), { explicit: true })).toBe("done");
	});

	it("skips a session that is still open (no SessionEnd, last line 1 h ago)", async () => {
		seedSession("s1", { ended: false, lastLineAgo: HOUR });
		expect(await summarizeSession(db, "s1", cfg())).toBe("skipped");
		expect(spawns()).toBe(0);
	});

	it("treats a session without SessionEnd but quiet for 24 h as ended", async () => {
		seedSession("s1", { ended: false, lastLineAgo: 25 * HOUR, startedAgo: 26 * HOUR });
		expect(await summarizeSession(db, "s1", cfg())).toBe("done");
	});

	it("returns capped at ai.maxPerDay without a spawn, and the session stays pending", async () => {
		for (const id of ["s1", "s2", "s3"]) seedSession(id);
		const c = cfg({ maxPerDay: 2 });
		expect(await summarizeSession(db, "s1", c)).toBe("done");
		expect(await summarizeSession(db, "s2", c)).toBe("done");
		expect(await summarizeSession(db, "s3", c)).toBe("capped");
		expect(spawns()).toBe(2);
		expect(row("s3")).toMatchObject({ summary: null, summary_error: null, type_source: "heuristic" });
		expect(pendingSummaryIds(db, { capture: "hooks" })).toEqual(["s3"]);
	});

	it("does not retry past the cap: the last slot used by the first attempt leaves the session capped", async () => {
		seedSession("s1");
		fake.scenario({ exitCode: 1, stderr: "boom" });
		const r = await summarizeSessionResult(db, "s1", cfg({ maxPerDay: 1 }));
		expect(r.status).toBe("capped");
		expect(spawns()).toBe(1);
		expect(row("s1")).toMatchObject({ summary_error: null, type_source: "heuristic" });
	});

	it("parallel summaries never pass the cap", async () => {
		const ids = ["s1", "s2", "s3", "s4", "s5"];
		for (const id of ids) seedSession(id);
		fake.scenario({ stdout: successResult(), delayMs: 300 });
		const c = cfg({ maxPerDay: 2 });
		const results = await Promise.all(ids.map((id) => summarizeSession(db, id, c)));
		expect(results.filter((s) => s === "done")).toHaveLength(2);
		expect(results.filter((s) => s === "capped")).toHaveLength(3);
		expect(spawns()).toBe(2);
		expect(count("SELECT count(*) AS n FROM ai_calls")).toBe(2);
	});

	it("retries once after a failure", async () => {
		seedSession("s1");
		fake.scenario([{ exitCode: 1, stderr: "boom" }, { stdout: successResult() }]);
		expect(await summarizeSession(db, "s1", cfg())).toBe("done");
		expect(count("SELECT count(*) AS n FROM ai_calls")).toBe(2);
		expect(row("s1").summary_error).toBeNull();
	});

	it("records summary_error and a heuristic type after two failures", async () => {
		seedSession("s1");
		fake.scenario({ exitCode: 1, stderr: "boom" });
		const r = await summarizeSessionResult(db, "s1", cfg());
		expect(r).toMatchObject({ status: "error", costUsd: null });
		expect(r.reason).toMatch(/^exit/);
		expect(spawns()).toBe(2);
		expect(row("s1")).toMatchObject({ type_source: "heuristic", session_type: "exploration", summary: null });
		expect(row("s1").summary_error).toMatch(/^exit 1/);
		expect(pendingSummaryIds(db, { capture: "hooks" })).toEqual([]); // errors are not pending
	});

	it("claude missing: no retry, no summary_error, and the session stays pending", async () => {
		seedSession("s1");
		restore();
		const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
		const saved = process.env[pathKey];
		process.env[pathKey] = join(h.home, "empty-bin");
		try {
			const r = await summarizeSessionResult(db, "s1", cfg());
			expect(r).toEqual({ status: "skipped", costUsd: null, reason: "claude is not on PATH" });
		} finally {
			process.env[pathKey] = saved;
			restore = fake.install();
		}
		expect(row("s1")).toMatchObject({ summary_error: null, type_source: "heuristic" });
		expect(count("SELECT count(*) AS n FROM ai_calls")).toBe(0);
		expect(pendingSummaryIds(db, { capture: "hooks" })).toEqual(["s1"]);
	});

	it("counts an output that fails the schema as a failure", async () => {
		seedSession("s1");
		fake.scenario({
			stdout: successResult({ summary: "x", session_type: "research", tags: [], outcome: "completed" }),
		});
		expect(await summarizeSession(db, "s1", cfg())).toBe("error");
		expect(row("s1").summary_error).toMatch(/^schema/);
	});

	it("a budget error is not retried", async () => {
		seedSession("s1");
		fake.scenario({ stdout: successResult(undefined, { is_error: true, subtype: "error_max_budget_usd" }) });
		expect(await summarizeSession(db, "s1", cfg())).toBe("error");
		expect(spawns()).toBe(1);
		expect(row("s1").summary_error).toMatch(/^budget/);
	});

	it("summarizes from stored turns, without --resume, when the transcript file is gone", async () => {
		seedSession("s1", { file: "gone" });
		expect(await summarizeSession(db, "s1", cfg())).toBe("done");
		const [inv] = fake.invocations();
		expect(inv.argv).not.toContain("--resume");
		expect(inv.stdin).toMatch(/transcript below/);
		expect(inv.stdin).toContain("You: please do step 0");
		expect(inv.stdin).toContain("You: please do step 2");
	});

	it("passes --model when ai.model is set", async () => {
		seedSession("s1");
		await summarizeSession(db, "s1", cfg({ model: "haiku" }));
		expect(fake.invocations()[0].argv.slice(-2)).toEqual(["--model", "haiku"]);
	});

	it("spawns nothing when summaries are off, and still sets the heuristic type", async () => {
		seedSession("s1");
		expect(await summarizeSession(db, "s1", cfg({ summaries: { enabled: false } }))).toBe("skipped");
		expect(spawns()).toBe(0);
		expect(row("s1").type_source).toBe("heuristic");
	});

	it("redacts a secret the model put in the summary", async () => {
		seedSession("s1");
		const secret = `sk-ant-api03-${"A".repeat(40)}`;
		fake.scenario({ stdout: successResult({ ...FAKE_SUMMARY, summary: `Rotated the key ${secret}.` }) });
		expect(await summarizeSession(db, "s1", cfg())).toBe("done");
		expect(row("s1").summary).toBe("Rotated the key [REDACTED].");
	});

	it("skips an unknown session", async () => {
		expect(await summarizeSession(db, "nope", cfg())).toBe("skipped");
	});
});

describe("pendingSummaryIds", () => {
	it("lists ended, unsummarized, error-free sessions with 2+ turns, oldest first, by capture", () => {
		seedSession("new", { startedAgo: 2 * HOUR, lastLineAgo: HOUR / 2 });
		seedSession("old", { startedAgo: 5 * HOUR });
		seedSession("imported", { capture: "backfill" });
		seedSession("short", { turns: 1 });
		seedSession("open", { ended: false, lastLineAgo: HOUR });
		seedSession("done", { typeSource: "ai" });
		expect(pendingSummaryIds(db, { capture: "hooks" })).toEqual(["old", "new"]);
		expect(pendingSummaryIds(db, { capture: "backfill" })).toEqual(["imported"]);
		expect(pendingSummaryIds(db, { capture: "hooks", limit: 1 })).toEqual(["old"]);
		expect(pendingSummaryIds(db, { capture: "hooks", since: new Date(Date.now() - 3 * HOUR) })).toEqual(["new"]);
	});
});

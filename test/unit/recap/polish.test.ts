// Phase 6 Task 8: opt-in AI polish — one runClaude call with feature "recap", validated, never retried.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Config, ConfigSchema } from "../../../src/config";
import type { Db } from "../../../src/db/adapter";
import { buildRecap } from "../../../src/recap/build";
import { estimatePolishCost, POLISH_SCHEMA, PolishError, polishPrompt, polishRecap } from "../../../src/recap/polish";
import type { Recap } from "../../../src/recap/types";
import { FAKE_RECAP, type FakeClaude, fakeClaude, successResult } from "../../helpers/fake-claude";
import { LEAK_DIR, LEAK_TOKEN, RECAP_DAY, RECAP_NOW, seedRecapFixture } from "../../helpers/recap-seed";
import { seedDb } from "../../helpers/seed";
import { type TmpHome, tmpHome } from "../../helpers/tmp-home";

let h: TmpHome;
let db: Db;
let fake: FakeClaude;
let restore: () => void;
beforeEach(() => {
	h = tmpHome();
	db = seedDb();
	seedRecapFixture(db);
	fake = fakeClaude(h.home);
	restore = fake.install();
});
afterEach(() => {
	restore();
	db.close();
	h.cleanup();
});

const cfg = (over: { model?: string; hidden?: string[] } = {}): Config => {
	const c = ConfigSchema.parse({});
	return { ...c, ai: { ...c.ai, model: over.model }, recap: { hiddenRepos: over.hidden ?? [] } };
};
const recapOf = (c = cfg(), groupBy: "repo" | "day" = "repo"): Recap =>
	buildRecap(db, c, { range: { from: RECAP_DAY, to: RECAP_DAY }, groupBy, files: true, now: RECAP_NOW });
const count = (table: string) =>
	db.prepare(`SELECT count(*) AS n FROM ${table} WHERE feature = 'recap'`).get<{ n: number }>()?.n ?? 0;
const reasonOf = async (p: Promise<unknown>): Promise<string> => {
	try {
		await p;
	} catch (e) {
		expect(e).toBeInstanceOf(PolishError);
		return (e as PolishError).reason;
	}
	throw new Error("expected a PolishError");
};

describe("polishRecap", () => {
	it("one call: sentinel, feature env, no --resume, model when set; one ai_calls and one self_usage row", async () => {
		fake.scenario({ stdout: successResult(FAKE_RECAP) });
		const p = await polishRecap(db, recapOf(cfg({ model: "haiku" })), cfg({ model: "haiku" }));
		const inv = fake.invocations();
		expect(inv).toHaveLength(1);
		expect(inv[0].stdin.split("\n")[0]).toBe("[cc-debrief:recap]");
		expect(inv[0].env.CC_DEBRIEF_FEATURE).toBe("recap");
		expect(inv[0].argv).not.toContain("--resume");
		expect(inv[0].argv.slice(inv[0].argv.indexOf("--model"), inv[0].argv.indexOf("--model") + 2)).toEqual([
			"--model",
			"haiku",
		]);
		expect(JSON.parse(inv[0].argv[inv[0].argv.indexOf("--json-schema") + 1])).toEqual(POLISH_SCHEMA);
		expect(p.groups).toEqual(FAKE_RECAP.groups);
		expect(p.range).toEqual({ from: RECAP_DAY, to: RECAP_DAY });
		expect(typeof p.costUsd).toBe("number");
		expect(count("ai_calls")).toBe(1);
		expect(count("self_usage")).toBe(1);
	});

	it("no --model without ai.model", async () => {
		fake.scenario({ stdout: successResult(FAKE_RECAP) });
		await polishRecap(db, recapOf(), cfg());
		expect(fake.invocations()[0].argv).not.toContain("--model");
	});

	it("the prompt holds bullets, base-name files and stored summaries, never prompts, directories or hidden repos", () => {
		const prompt = polishPrompt(db, recapOf(cfg({ hidden: ["secret-client"] })));
		expect(prompt).toContain("Add rate limiting to the public endpoints");
		expect(prompt).toContain("errors.go");
		expect(prompt).toContain("Added a limiter. Also tests.");
		expect(prompt).not.toContain(LEAK_TOKEN);
		expect(prompt).not.toContain(LEAK_DIR);
		expect(prompt).not.toContain("/home/u");
		expect(prompt).not.toContain("secret-client");
		expect(prompt).not.toContain("Secret client billing");
		expect(prompt).not.toContain("invoice");
	});

	it("stored summaries reach the prompt with paths cut to base names", () => {
		db.prepare("UPDATE sessions SET summary = ? WHERE session_id = 'titled'").run(
			`Fixed /home/u/clients/${LEAK_DIR}/src/pay.ts and C:\\work\\${LEAK_DIR}\\b.ts.`,
		);
		const prompt = polishPrompt(db, recapOf());
		expect(prompt).toContain("Fixed pay.ts and b.ts.");
		expect(prompt).not.toContain(LEAK_DIR);
	});

	it("by day: the polish input merges the days into repo groups", () => {
		const prompt = polishPrompt(db, recapOf(cfg(), "day"));
		const json = JSON.parse(prompt.slice(prompt.indexOf("{"))) as { repos: { repo: string }[] };
		expect(json.repos.map((r) => r.repo)).toEqual([
			"checkout-flow",
			"api-gateway",
			"notes",
			"scratch",
			"secret-client",
		]);
	});

	it.each([
		["an unknown repo label", { stdout: successResult({ groups: [{ repo: "made-up", items: ["x"] }] }) }, "schema"],
		["no items for a non-empty recap", { stdout: successResult({ groups: [] }) }, "schema"],
		["a malformed result", { stdout: successResult({ nope: true }) }, "schema"],
		["claude exits 1", { exitCode: 1, stderr: "boom" }, "exit"],
	])("%s: PolishError, one spawn, no retry", async (_name, scenario, reason) => {
		fake.scenario(scenario);
		expect(await reasonOf(polishRecap(db, recapOf(), cfg()))).toBe(reason);
		expect(fake.calls()).toHaveLength(1);
	});

	it("a timeout: PolishError(timeout), one spawn", async () => {
		fake.scenario({ stdout: successResult(FAKE_RECAP), delayMs: 3000 });
		expect(await reasonOf(polishRecap(db, recapOf(), cfg(), { timeoutMs: 300 }))).toBe("timeout");
		expect(fake.calls()).toHaveLength(1);
	});

	it("an empty recap makes no call", async () => {
		const empty = buildRecap(db, cfg(), {
			range: { from: "2026-01-05", to: "2026-01-05" },
			groupBy: "repo",
			files: true,
		});
		expect(await polishRecap(db, empty, cfg())).toEqual({ range: empty.range, groups: [], costUsd: 0 });
		expect(fake.calls()).toEqual([]);
	});

	it("blank items are dropped", async () => {
		fake.scenario({ stdout: successResult({ groups: [{ repo: "notes", items: ["  ", "Fixed export"] }] }) });
		expect((await polishRecap(db, recapOf(), cfg())).groups).toEqual([{ repo: "notes", items: ["Fixed export"] }]);
	});
});

describe("estimatePolishCost", () => {
	const selfRow = (id: string, usd: number, ts: string) =>
		db
			.prepare(
				"INSERT INTO self_usage (feature, session_id, model, cost_usd, ts) VALUES ('recap', ?, 'claude-haiku-4-5', ?, ?)",
			)
			.run(id, usd, ts);
	it("prices the prompt / 4 plus 600 output tokens on ai.model with fewer than 3 calls", () => {
		const r = recapOf();
		const est = estimatePolishCost(db, r, cfg({ model: "claude-haiku-4-5" }));
		expect(est).toBeGreaterThan(0);
		selfRow("a", 1, "2026-09-01T00:00:00Z");
		selfRow("b", 1, "2026-09-02T00:00:00Z");
		expect(estimatePolishCost(db, r, cfg({ model: "claude-haiku-4-5" }))).toBe(est);
	});
	it("null without a priceable model", () => expect(estimatePolishCost(db, recapOf(), cfg())).toBeNull());
	it("3+ calls: the mean of the last 10", () => {
		for (let i = 0; i < 12; i++)
			selfRow(`c${i}`, i < 2 ? 5 : 0.02, `2026-09-${String(i + 1).padStart(2, "0")}T00:00:00Z`);
		expect(estimatePolishCost(db, recapOf(), cfg())).toBeCloseTo(0.02, 10);
	});
});

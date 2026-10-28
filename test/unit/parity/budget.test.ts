// Phase 7 Task 6 (P4): the monthly budget — projection, levels (U2), month boundaries in local time, the digest item.
// `npm run test:tz` runs it in UTC, Asia/Kolkata and America/Los_Angeles.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildDigest, DIGEST_RULES, runDigestRules } from "../../../src/coach/digest";
import { budgetOver } from "../../../src/coach/digest-rules/budget-over";
import { ruleLabel } from "../../../src/coach/labels";
import { type Config, ConfigSchema, loadConfig } from "../../../src/config";
import { type Db, openDb } from "../../../src/db/adapter";
import { migrate } from "../../../src/db/migrate";
import { getBudget } from "../../../src/db/queries/budget";
import { runCli } from "../../../src/program";
import { seedParitySession } from "../../helpers/parity-seed";
import { type TmpHome, tmpHome } from "../../helpers/tmp-home";

let db: Db;
beforeEach(() => {
	db = openDb(":memory:");
	migrate(db);
});
afterEach(() => db.close());

const cfg = (monthlyUsd: number | null): Config => ConfigSchema.parse({ budget: { monthlyUsd } });
/** A session costing `usd` (priced input tokens on a $1/M model would need overrides; cost is set directly). */
const spend = (id: string, at: Date, usd: number) =>
	seedParitySession(db, id, { startedAt: at.toISOString(), usage: [{ input: 1000, cost: usd }] });

describe("getBudget", () => {
	it("is null when no budget is set", () => {
		spend("a", new Date(2026, 9, 5, 10), 50);
		expect(getBudget(db, cfg(null), new Date(2026, 9, 10, 12))).toBeNull();
		expect(ConfigSchema.parse({}).budget.monthlyUsd).toBeNull();
	});

	it("projects month-to-date ÷ elapsed days × days in the month", () => {
		spend("a", new Date(2026, 9, 2, 10), 30);
		spend("b", new Date(2026, 9, 9, 23, 30), 20);
		spend("prev", new Date(2026, 8, 30, 23, 59), 999); // September: not this month
		const b = getBudget(db, cfg(200), new Date(2026, 9, 10, 12));
		expect(b).toEqual({ budgetUsd: 200, monthToDateUsd: 50, projectedUsd: 155, level: "ok", daysLeft: 21 }); // 77.5%
	});

	it("day 1 projects today's spend over the whole month", () => {
		spend("a", new Date(2026, 9, 1, 0, 5), 2);
		expect(getBudget(db, cfg(100), new Date(2026, 9, 1, 9))).toEqual({
			budgetUsd: 100,
			monthToDateUsd: 2,
			projectedUsd: 62,
			level: "ok",
			daysLeft: 30,
		});
	});

	it("the last day projects the month-to-date itself", () => {
		spend("a", new Date(2026, 1, 3, 10), 90);
		expect(getBudget(db, cfg(100), new Date(2026, 1, 28, 20))).toMatchObject({
			projectedUsd: 90,
			level: "warn",
			daysLeft: 0,
		});
	});

	it("levels: ok below 80%, warn from 80%, over from 100% of the projection", () => {
		const now = new Date(2026, 9, 31, 12); // 31-day month, last day: projection = month-to-date
		spend("a", new Date(2026, 9, 3), 79.99);
		expect(getBudget(db, cfg(100), now)?.level).toBe("ok");
		spend("b", new Date(2026, 9, 4), 0.01);
		expect(getBudget(db, cfg(100), now)?.level).toBe("warn");
		spend("c", new Date(2026, 9, 5), 20);
		expect(getBudget(db, cfg(100), now)?.level).toBe("over");
	});

	it("the month starts at local midnight on the 1st", () => {
		spend("lastOfSep", new Date(2026, 8, 30, 23, 59, 59), 10);
		spend("firstOfOct", new Date(2026, 9, 1, 0, 0, 1), 5);
		expect(getBudget(db, cfg(100), new Date(2026, 9, 1, 0, 1))?.monthToDateUsd).toBe(5);
	});

	it("leaves out the tracker's own calls", () => {
		spend("a", new Date(2026, 9, 2), 10);
		db.prepare(
			"INSERT INTO self_usage (feature, session_id, model, cost_usd, ts) VALUES ('summary', 's', 'claude-sonnet-4-5', 50, ?)",
		).run(new Date(2026, 9, 3).toISOString());
		expect(getBudget(db, cfg(100), new Date(2026, 9, 10))?.monthToDateUsd).toBe(10);
	});
});

describe("budget_over digest item", () => {
	let h: TmpHome;
	beforeEach(() => {
		h = tmpHome();
	});
	afterEach(() => h.cleanup());

	it("is registered with a label", () => {
		expect(DIGEST_RULES.map((r) => r.rule)).toContain("budget_over");
		expect(ruleLabel("budget_over")).toBe("over budget");
	});

	it("fires once per month when the projection reaches the budget, with the month as subject", async () => {
		await runCli(["config", "set", "budget.monthlyUsd", "100"]);
		spend("a", new Date(2026, 9, 2), 60);
		const now = new Date(2026, 9, 10, 12);
		const [f] = budgetOver.run(db, now);
		expect(f).toMatchObject({
			rule: "budget_over",
			severity: "medium",
			target: "overview",
			evidence: { key: "2026-10" },
			message: "On pace for $186 this month, over the $100 budget",
		});
		expect(f.costTokens).toBeGreaterThan(0);
		runDigestRules(db, now, [budgetOver]);
		runDigestRules(db, new Date(2026, 9, 11, 12), [budgetOver]);
		const rows = db.prepare("SELECT subject_key FROM findings WHERE rule = 'budget_over'").all();
		expect(rows).toEqual([{ subject_key: "2026-10" }]);
	});

	it("says nothing below the budget or with no budget", async () => {
		spend("a", new Date(2026, 9, 2), 60);
		expect(budgetOver.run(db, new Date(2026, 9, 10))).toEqual([]);
		await runCli(["config", "set", "budget.monthlyUsd", "1000"]);
		expect(budgetOver.run(db, new Date(2026, 9, 10))).toEqual([]);
	});
});

describe("budget.monthlyUsd config", () => {
	let h: TmpHome;
	beforeEach(() => {
		h = tmpHome();
	});
	afterEach(() => {
		vi.restoreAllMocks();
		h.cleanup();
	});
	const run = async (...args: string[]) => {
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const code = await runCli(args);
		vi.restoreAllMocks();
		return code;
	};

	it("sets a number, clears with null, rejects 0 and words", async () => {
		expect(await run("config", "set", "budget.monthlyUsd", "250")).toBe(0);
		expect(loadConfig().budget.monthlyUsd).toBe(250);
		expect(await run("config", "set", "budget.monthlyUsd", "null")).toBe(0);
		expect(loadConfig().budget.monthlyUsd).toBeNull();
		expect(await run("config", "set", "budget.monthlyUsd", "0")).toBe(2);
		expect(await run("config", "set", "budget.monthlyUsd", "lots")).toBe(2);
	});
});

describe("budget_over in the digest", () => {
	let h: TmpHome;
	beforeEach(() => {
		h = tmpHome();
	});
	afterEach(() => h.cleanup());

	it("links to the Costs view", async () => {
		await runCli(["config", "set", "budget.monthlyUsd", "10"]);
		const now = new Date();
		spend("a", new Date(now.getFullYear(), now.getMonth(), 1, 0, 1), 60);
		runDigestRules(db, now, [budgetOver]);
		const { items } = buildDigest(db, { range: "7d", now });
		expect(items.map((i) => [i.rule, i.href])).toEqual([["budget_over", "/costs"]]);
	});
});

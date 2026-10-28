// Phase 7 Task 5 (P3 + P6): getCosts() — per day by model, by repo, per model, cache rate and savings, run rate.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PLAN_PRICES, PRICE_TABLE } from "../../../src/collector/prices";
import { type Config, ConfigSchema } from "../../../src/config";
import { type Db, openDb } from "../../../src/db/adapter";
import { migrate } from "../../../src/db/migrate";
import { getCosts } from "../../../src/db/queries/costs";
import { getOverview } from "../../../src/db/queries/overview";
import { localAt, PARITY_NOW, REPO_A, REPO_B, seedParitySession } from "../../helpers/parity-seed";

let db: Db;
const cfg: Config = ConfigSchema.parse({});
beforeEach(() => {
	db = openDb(":memory:");
	migrate(db);
});
afterEach(() => db.close());

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const perDayTotal = (c: ReturnType<typeof getCosts>) => sum(c.perDay.flatMap((d) => Object.values(d.byModel)));

function seedMix() {
	seedParitySession(db, "a1", {
		startedAt: localAt(0, 9),
		repo: REPO_A,
		usage: [
			{ model: "claude-sonnet-4-5", input: 1000, output: 2000, cacheWrite: 3000, cacheRead: 400_000 },
			{ model: "claude-opus-4-1", input: 100, output: 300, cacheRead: 10_000, ts: localAt(0, 9, 30) },
		],
	});
	seedParitySession(db, "a2", {
		startedAt: localAt(3, 14),
		repo: REPO_A,
		usage: [{ model: "claude-haiku-4-5", input: 5000, output: 100, cacheRead: 50_000 }],
	});
	seedParitySession(db, "b1", {
		startedAt: localAt(5, 11),
		repo: REPO_B,
		usage: [{ model: "claude-sonnet-4-5", input: 200, output: 100, cacheRead: 1000 }],
		// Claude Code's own total: more than the counted rows (background calls).
		reported: {
			costUsd: 0.5,
			models: { "claude-sonnet-4-5": { input: 400, output: 200, cacheRead: 2000, costUsd: 0.5 } },
		},
	});
	seedParitySession(db, "n1", {
		startedAt: localAt(6, 8),
		usage: [{ model: "acme-local-7b", input: 7000, output: 70, cost: null }],
	});
	seedParitySession(db, "old", {
		startedAt: localAt(40, 8),
		repo: REPO_B,
		usage: [{ model: "claude-opus-4-1", input: 100_000, output: 10_000 }],
	});
}

describe("getCosts", () => {
	it("totals equal the Overview cost tile for the same range and repo, and the days sum to it", () => {
		seedMix();
		for (const range of ["today", "7d", "30d", "90d", "all"] as const) {
			for (const repo of [undefined, REPO_A.id]) {
				const c = getCosts(db, { range, repo, now: PARITY_NOW, cfg });
				const o = getOverview(db, { range, repo, now: PARITY_NOW });
				expect(c.totalUsd, `${range} ${repo}`).toBeCloseTo(o.tiles.cost.usd, 6);
				expect(perDayTotal(c), `${range} ${repo} days`).toBeCloseTo(c.totalUsd, 6);
				expect(c.unknownModelTokens).toBe(o.tiles.cost.unknownModelTokens);
			}
		}
	});

	it("puts cost on local days, stacked by model family", () => {
		seedMix();
		const c = getCosts(db, { range: "7d", now: PARITY_NOW, cfg });
		const today = c.perDay.at(-1);
		expect(today?.date).toBe("2026-10-17");
		expect(Object.keys(today?.byModel ?? {}).sort()).toEqual(["Opus", "Sonnet"]);
		expect(c.perDay.find((d) => d.date === "2026-10-12")?.byModel).toEqual({ Sonnet: 0.5 });
		expect(c.truncated).toBe(false);
	});

	it("groups cost by repo, with sessions outside a repo as no repo", () => {
		seedMix();
		const c = getCosts(db, { range: "7d", now: PARITY_NOW, cfg });
		// Most expensive first: web is b1's reported $0.50; n1 has only unpriced tokens.
		expect(c.byRepo.map((r) => r.name)).toEqual(["web", "api", "no repo"]);
		expect(c.byRepo[0]).toEqual({ repoId: REPO_B.id, name: "web", usd: 0.5 });
		expect(c.byRepo[2]).toEqual({ repoId: null, name: "no repo", usd: 0 });
	});

	it("lists per-model token splits; an unknown model is counted, flagged and never priced", () => {
		seedMix();
		const c = getCosts(db, { range: "7d", now: PARITY_NOW, cfg });
		const unknown = c.models.find((m) => m.model === "acme-local-7b");
		expect(unknown).toMatchObject({ input: 7000, output: 70, usd: null });
		expect(c.unknownModelTokens).toBe(7070);
		const sonnet = c.models.find((m) => m.model === "claude-sonnet-4-5");
		// a1's counted rows plus b1's reported split
		expect(sonnet).toMatchObject({ label: "Sonnet", input: 1400, output: 2200, cacheWrite: 3000, cacheRead: 402_000 });
	});

	it("cache savings = cache-read tokens × (input − cache-read price) per model, from usage rows", () => {
		seedMix();
		const c = getCosts(db, { range: "7d", now: PARITY_NOW, cfg });
		const s = PRICE_TABLE["claude-sonnet-4-5"];
		const o = PRICE_TABLE["claude-opus-4-1"];
		const hk = PRICE_TABLE["claude-haiku-4-5"];
		const expected =
			((400_000 + 1000) * (s.input - s.cacheRead) +
				10_000 * (o.input - o.cacheRead) +
				50_000 * (hk.input - hk.cacheRead)) /
			1e6;
		expect(c.cacheSavingsUsd).toBeCloseTo(expected, 6);
		const sides = 1000 + 3000 + 400_000 + 100 + 10_000 + 5000 + 50_000 + 400 + 2000 + 7000;
		expect(c.cacheHitPct).toBeCloseTo(Math.round(((400_000 + 10_000 + 50_000 + 2000) / sides) * 1000) / 10, 6);
	});

	it("cache savings follow pricing overrides", () => {
		seedParitySession(db, "x", { startedAt: localAt(0), usage: [{ model: "claude-opus-4-1", cacheRead: 1_000_000 }] });
		const over = ConfigSchema.parse({ pricing: { overrides: { opus: { input: 10, output: 10, cacheRead: 1 } } } });
		expect(getCosts(db, { range: "7d", now: PARITY_NOW, cfg: over }).cacheSavingsUsd).toBeCloseTo(9, 6);
	});

	it("run rate uses the last 30 days whatever the range or repo, with the plan prices and their date", () => {
		seedMix();
		const week = getCosts(db, { range: "7d", now: PARITY_NOW, cfg });
		const today = getCosts(db, { range: "today", repo: REPO_A.id, now: PARITY_NOW, cfg });
		expect(today.runRate).toEqual(week.runRate);
		expect(week.runRate.last30Usd).toBeCloseTo(week.totalUsd, 6); // "old" is 40 days back
		expect(week.runRate.monthlyUsd).toBeCloseTo((week.runRate.last30Usd / 30) * (365.25 / 12), 6);
		expect(week.runRate.plans).toEqual(PLAN_PRICES.plans);
		expect(week.runRate.pricesAsOf).toBe(PLAN_PRICES.asOf);
		expect(PLAN_PRICES.plans).toEqual([
			{ name: "Pro", usd: 20 },
			{ name: "Max 5x", usd: 100 },
			{ name: "Max 20x", usd: 200 },
		]);
	});

	it("leaves out the tracker's own claude -p calls", () => {
		seedMix();
		const before = getCosts(db, { range: "7d", now: PARITY_NOW, cfg }).totalUsd;
		db.prepare(
			"INSERT INTO self_usage (feature, session_id, model, input_tokens, cost_usd, ts) VALUES ('summary', 'self-1', 'claude-sonnet-4-5', 1000, 3, ?)",
		).run(localAt(0, 12));
		expect(getCosts(db, { range: "7d", now: PARITY_NOW, cfg }).totalUsd).toBe(before);
	});

	it("an empty database gives zeros and empty lists", () => {
		const c = getCosts(db, { range: "30d", now: PARITY_NOW, cfg });
		expect(c).toMatchObject({ totalUsd: 0, byRepo: [], models: [], cacheHitPct: 0, cacheSavingsUsd: 0 });
		expect(c.perDay).toHaveLength(30);
		expect(c.runRate.last30Usd).toBe(0);
	});

	it("all over 400 days of data keeps the newest 366 days and says so", () => {
		seedParitySession(db, "ancient", { startedAt: localAt(399), usage: [{ input: 1000 }] });
		seedParitySession(db, "new", { startedAt: localAt(1), usage: [{ input: 1000 }] });
		const c = getCosts(db, { range: "all", now: PARITY_NOW, cfg });
		expect(c.perDay).toHaveLength(366);
		expect(c.truncated).toBe(true);
		// Spend before the first shown day is left off the chart and reported, not piled onto day one (final review I3).
		const ancient = 1000 * 3e-6; // 1,000 Sonnet input tokens
		expect(c.beforeUsd).toBeCloseTo(ancient, 9);
		expect(perDayTotal(c)).toBeCloseTo(c.totalUsd - ancient, 9);
		expect(Object.values(c.perDay[0].byModel)).toEqual([]);
	});

	it("beforeUsd is 0 when nothing was cut", () => {
		seedParitySession(db, "new", { startedAt: localAt(1), usage: [{ input: 1000 }] });
		expect(getCosts(db, { range: "all", now: PARITY_NOW, cfg }).beforeUsd).toBe(0);
	});
});

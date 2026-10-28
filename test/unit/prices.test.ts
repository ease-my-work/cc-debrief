import { describe, expect, it } from "vitest";
import { estimateCost, modelFamily, PRICE_TABLE, PRICE_TABLE_VERSION } from "../../src/collector/prices";
import { usageFromLines } from "../../src/collector/transcript";
import { phase0Cases, storedLines } from "../helpers/fixtures";

const u = (model: string, i: number, o: number, cw: number, cr: number, cw1h = 0) => ({
	model,
	inputTokens: i,
	outputTokens: o,
	cacheCreationTokens: cw,
	cacheCreation1hTokens: cw1h,
	cacheReadTokens: cr,
});

describe("PRICE_TABLE", () => {
	it("carries a date version", () => {
		expect(PRICE_TABLE_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});

	it("follows the published cache multipliers for every model", () => {
		const readMultiplier: Record<string, number> = {
			"claude-fable-5-1": 0.025,
			"claude-mythos-5-1": 0.025,
			"claude-opus-5-5": 0.05,
		};
		for (const [family, p] of Object.entries(PRICE_TABLE)) {
			expect(p.cacheWrite, family).toBeCloseTo(p.input * 1.25, 10);
			expect(p.cacheWrite1h, family).toBeCloseTo(p.input * 2, 10);
			expect(p.cacheRead, family).toBeCloseTo(p.input * (readMultiplier[family] ?? 0.1), 10);
		}
	});

	it("has the published base prices for the current models", () => {
		expect(PRICE_TABLE["claude-opus-5-5"]).toMatchObject({ input: 4, output: 20 });
		expect(PRICE_TABLE["claude-sonnet-5-5"]).toMatchObject({ input: 2, output: 10 });
		expect(PRICE_TABLE["claude-haiku-4-5"]).toMatchObject({ input: 1, output: 5 });
		expect(PRICE_TABLE["claude-fable-5-1"]).toMatchObject({ input: 10, output: 50 });
	});
});

describe("modelFamily", () => {
	it.each([
		["claude-opus-5-5", "claude-opus-5-5"],
		["claude-haiku-4-5-20251001", "claude-haiku-4-5"],
		["claude-opus-5-5[1m]", "claude-opus-5-5"],
		["claude-opus-4-0", "claude-opus-4"],
		["claude-opus-4-20250514", "claude-opus-4"],
		["claude-opus-4-1-20250805", "claude-opus-4-1"],
		["claude-3-5-haiku-20241022", "claude-3-5-haiku"],
		["anthropic.claude-sonnet-4-5-20250929-v1:0", "claude-sonnet-4-5"],
		["us.anthropic.claude-opus-4-8", "claude-opus-4-8"],
		["claude-opus-4-5@20251101", "claude-opus-4-5"],
		["CLAUDE-SONNET-5", "claude-sonnet-5"],
		["<synthetic>", null],
		["gpt-9", null],
		["", null],
	])("%s → %s", (id, family) => {
		expect(modelFamily(id)).toBe(family);
	});
});

describe("estimateCost", () => {
	it("prices a known model: (in*input + out*output + cw*cacheWrite + cr*cacheRead) / 1e6", () => {
		const p = PRICE_TABLE["claude-opus-5-5"];
		expect(estimateCost(u("claude-opus-5-5", 1000, 2000, 3000, 4000))).toBeCloseTo(
			(1000 * p.input + 2000 * p.output + 3000 * p.cacheWrite + 4000 * p.cacheRead) / 1e6,
			12,
		);
	});

	it("prices 1-hour cache writes at the 1-hour rate", () => {
		const p = PRICE_TABLE["claude-opus-5-5"];
		expect(estimateCost(u("claude-opus-5-5", 0, 0, 3000, 0, 1000))).toBeCloseTo(
			(2000 * p.cacheWrite + 1000 * p.cacheWrite1h) / 1e6,
			12,
		);
	});

	it("prices dated and [1m] ids like their family", () => {
		const base = estimateCost(u("claude-haiku-4-5", 10, 20, 30, 40));
		expect(estimateCost(u("claude-haiku-4-5-20251001", 10, 20, 30, 40))).toBe(base);
		expect(estimateCost(u("claude-opus-5-5[1m]", 10, 20, 30, 40))).toBe(
			estimateCost(u("claude-opus-5-5", 10, 20, 30, 40)),
		);
	});

	it("returns null for an unknown model", () => {
		expect(estimateCost(u("some-other-model", 10, 20, 30, 40))).toBeNull();
	});

	it("knows every model that appears in the Phase 0 fixtures", () => {
		const models = new Set(phase0Cases().flatMap(({ dir }) => usageFromLines(storedLines(dir)).map((r) => r.model)));
		expect(models.size).toBeGreaterThan(0);
		for (const m of models) expect(modelFamily(m), m).not.toBeNull();
	});
});

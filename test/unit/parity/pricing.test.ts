// Phase 7 Task 4 (P7): pricing overrides merged over the built-in table, versioned, re-priced by derive.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	effectivePriceTable,
	effectivePriceVersion,
	estimateCost,
	PRICE_TABLE,
	PRICE_TABLE_VERSION,
} from "../../../src/collector/prices";
import { loadConfig, updateConfig } from "../../../src/config";
import type { Db } from "../../../src/db/adapter";
import { getMeta } from "../../../src/db/queries/meta";
import { repriceStale, stalePriceSessions } from "../../../src/derive/reprice";
import { deriveSession } from "../../../src/derive/session";
import { runCli } from "../../../src/program";
import { seedDb, storeLines } from "../../helpers/seed";
import { type TmpHome, tmpHome } from "../../helpers/tmp-home";

const row = (model: string, t: Partial<Record<"i" | "o" | "cw" | "cr", number>>) => ({
	model,
	inputTokens: t.i ?? 0,
	outputTokens: t.o ?? 0,
	cacheCreationTokens: t.cw ?? 0,
	cacheCreation1hTokens: 0,
	cacheReadTokens: t.cr ?? 0,
});
const M = 1_000_000;

describe("effectivePriceTable", () => {
	it("no overrides is the built-in table and version", () => {
		expect(effectivePriceTable({})).toEqual(PRICE_TABLE);
		expect(effectivePriceVersion({})).toBe(PRICE_TABLE_VERSION);
	});

	it("a family override applies to every id of that family, and to an id the table does not know", () => {
		const t = effectivePriceTable({ opus: { input: 1, output: 2 } });
		expect(estimateCost(row("claude-opus-5-5", { i: M }), t)).toBeCloseTo(1);
		expect(estimateCost(row("claude-opus-4-1", { o: M }), t)).toBeCloseTo(2);
		expect(estimateCost(row("claude-opus-9-20270101", { i: M }), t)).toBeCloseTo(1);
		expect(estimateCost(row("claude-sonnet-4-5", { i: M }), t)).toBeCloseTo(3); // other families untouched
	});

	it("a model-id override beats a family override", () => {
		const t = effectivePriceTable({ opus: { input: 1, output: 2 }, "claude-opus-5-5": { input: 7, output: 9 } });
		expect(estimateCost(row("claude-opus-5-5[1m]", { i: M }), t)).toBeCloseTo(7);
		expect(estimateCost(row("claude-opus-4-8", { i: M }), t)).toBeCloseTo(1);
	});

	it("cache prices default from input like the built-in rows, unless given", () => {
		const t = effectivePriceTable({
			haiku: { input: 2, output: 4 },
			"claude-sonnet-4-5": { input: 2, output: 4, cacheRead: 1 },
		});
		expect(t["claude-haiku-4-5"]).toEqual({ input: 2, output: 4, cacheWrite: 2.5, cacheWrite1h: 4, cacheRead: 0.2 });
		expect(t["claude-sonnet-4-5"].cacheRead).toBe(1);
	});

	it("an override keyed by a dated or prefixed id (as the Costs table shows it) applies (final review I1)", () => {
		const t = effectivePriceTable({ "claude-haiku-4-5-20251001": { input: 99, output: 1 } });
		expect(estimateCost(row("claude-haiku-4-5-20251001", { i: M }), t)).toBeCloseTo(99);
		expect(estimateCost(row("claude-haiku-4-5", { i: M }), t)).toBeCloseTo(99);
		const n = effectivePriceTable({ "us.anthropic.claude-newmodel-20261001-v1:0": { input: 3, output: 3 } });
		expect(estimateCost(row("claude-newmodel-20261001", { i: M }), n)).toBeCloseTo(3);
	});

	it("an unknown model with no override stays unpriced", () => {
		expect(
			estimateCost(row("acme-local-7b", { i: M }), effectivePriceTable({ opus: { input: 1, output: 1 } })),
		).toBeNull();
	});

	it("the version changes with the overrides and ignores key order", () => {
		const a = effectivePriceVersion({ opus: { input: 1, output: 2 }, haiku: { input: 1, output: 1 } });
		const b = effectivePriceVersion({ haiku: { output: 1, input: 1 }, opus: { output: 2, input: 1 } });
		expect(a).toBe(b);
		expect(a).toMatch(new RegExp(`^${PRICE_TABLE_VERSION}\\+[0-9a-f]{8}$`));
		expect(effectivePriceVersion({ opus: { input: 1, output: 3 } })).not.toBe(a);
	});
});

describe("pricing.overrides config", () => {
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

	it("config set accepts a valid override map and one model's entry", async () => {
		expect(await run("config", "set", "pricing.overrides", '{"opus":{"input":4,"output":20}}')).toBe(0);
		expect(await run("config", "set", "pricing.overrides.claude-haiku-4-5", '{"input":1,"output":5}')).toBe(0);
		expect(loadConfig().pricing.overrides).toEqual({
			opus: { input: 4, output: 20 },
			"claude-haiku-4-5": { input: 1, output: 5 },
		});
	});

	it.each([
		'{"opus":{"input":-1,"output":2}}',
		'{"opus":{"input":1}}',
		'{"opus":{"input":1,"output":2,"bogus":3}}',
		'{"":{"input":1,"output":2}}',
		'{"opus":{"input":20000,"output":2}}',
	])("config set rejects %s with exit 2", async (value) => {
		expect(await run("config", "set", "pricing.overrides", value)).toBe(2);
		expect(loadConfig().pricing.overrides).toEqual({});
	});
});

describe("re-pricing", () => {
	let h: TmpHome;
	let db: Db;
	beforeEach(() => {
		h = tmpHome();
		db = seedDb();
	});
	afterEach(() => {
		db.close();
		h.cleanup();
	});

	const lines = (id: string) => [
		{
			type: "user",
			uuid: `${id}-u1`,
			timestamp: "2026-10-01T10:00:00.000Z",
			cwd: "/w/app",
			entrypoint: "cli",
			message: { role: "user", content: "hello" },
		},
		{
			type: "assistant",
			uuid: `${id}-a1`,
			timestamp: "2026-10-01T10:00:05.000Z",
			requestId: `${id}-r1`,
			message: {
				id: `${id}-m1`,
				model: "claude-opus-4-1",
				role: "assistant",
				content: [{ type: "text", text: "hi" }],
				usage: { input_tokens: M, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
			},
		},
	];
	const usageRow = (id: string) =>
		db
			.prepare("SELECT input_tokens AS i, output_tokens AS o, cost_usd AS c FROM usage WHERE session_id = ?")
			.get<{ i: number; o: number; c: number }>(id);

	it("a session that fails to re-derive is skipped and counted; the rest are still re-priced (final review I2)", async () => {
		storeLines(db, "s1", lines("s1"));
		deriveSession(db, "s1", { full: true });
		// Sorts first and cannot be locked (not a session id), so its re-derive throws.
		db.prepare("INSERT INTO meta (key, value) VALUES ('derive:a bad id', '{\"price\":\"old\"}')").run();
		updateConfig({ set: { "pricing.overrides": { opus: { input: 4, output: 20 } } } });
		const r = await repriceStale(db);
		expect(r).toEqual({ repriced: 1, failed: 1 });
		expect(usageRow("s1")?.c).toBe(4);
	});

	it("an override change re-prices usage.cost_usd, keeps tokens, and removing it restores the built-in price", async () => {
		storeLines(db, "s1", lines("s1"));
		deriveSession(db, "s1", { full: true });
		expect(usageRow("s1")).toEqual({ i: M, o: 0, c: 15 });
		expect(getMeta(db, "price_table_version")).toBe(PRICE_TABLE_VERSION);
		expect(stalePriceSessions(db)).toEqual([]);

		updateConfig({ set: { "pricing.overrides": { opus: { input: 4, output: 20 } } } });
		expect(stalePriceSessions(db)).toEqual(["s1"]);
		const progress: [number, number][] = [];
		await repriceStale(db, { onProgress: (done, total) => progress.push([done, total]) });
		expect(usageRow("s1")).toEqual({ i: M, o: 0, c: 4 });
		expect(getMeta(db, "price_table_version")).toBe(effectivePriceVersion({ opus: { input: 4, output: 20 } }));
		expect(progress.at(-1)).toEqual([1, 1]);
		expect(stalePriceSessions(db)).toEqual([]);

		updateConfig({ unset: ["pricing.overrides"] });
		await repriceStale(db);
		expect(usageRow("s1")).toEqual({ i: M, o: 0, c: 15 });
	});
});

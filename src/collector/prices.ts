// Bundled Claude price table for cost estimates. Source: the published model pricing table
// (platform.claude.com/docs/en/about-claude/pricing), first-party API, global routing, standard speed.
import { createHash } from "node:crypto";
import type { UsageRow } from "./transcript";

export const PRICE_TABLE_VERSION = "2026-09-30";

export type Price = { input: number; output: number; cacheWrite: number; cacheWrite1h: number; cacheRead: number };

// USD per million tokens. cacheWrite = 5-minute write (1.25x input), cacheWrite1h = 1-hour write (2x input);
// cacheRead = 0.1x input, except 0.05x on Opus 5.5 and 0.025x on Fable 5.1 / Mythos 5.1.
const price = (input: number, output: number, readMultiplier = 0.1): Price => ({
	input,
	output,
	cacheWrite: input * 1.25,
	cacheWrite1h: input * 2,
	cacheRead: input * readMultiplier,
});

export const PRICE_TABLE: Record<string, Price> = {
	"claude-fable-5-1": price(10, 50, 0.025),
	"claude-mythos-5-1": price(10, 50, 0.025),
	"claude-fable-5": price(10, 50),
	"claude-mythos-5": price(10, 50),
	"claude-opus-5-5": price(4, 20, 0.05),
	"claude-opus-5": price(5, 25),
	"claude-opus-4-8": price(5, 25),
	"claude-opus-4-7": price(5, 25),
	"claude-opus-4-6": price(5, 25),
	"claude-opus-4-5": price(5, 25),
	"claude-opus-4-1": price(15, 75),
	"claude-opus-4": price(15, 75),
	"claude-sonnet-5-5": price(2, 10),
	"claude-sonnet-5": price(2, 10),
	"claude-sonnet-4-6": price(3, 15),
	"claude-sonnet-4-5": price(3, 15),
	"claude-sonnet-4": price(3, 15),
	"claude-haiku-4-5": price(1, 5),
	"claude-3-5-haiku": price(0.8, 4),
};

/** A model id lower-cased, without a context tag, provider prefix, "-v1:0" version or date suffix. */
export function normalizeModelId(modelId: string): string {
	let id = modelId.toLowerCase().trim();
	id = id.replace(/\[[^\]]*\]/g, "");
	id = id.replace(/^(?:[a-z]+\.)?anthropic\./, "");
	id = id.replace(/-v\d+(?::\d+)?$/, "");
	return id.replace(/[-@]\d{8}$/, "");
}

/**
 * The PRICE_TABLE key for a model id as it appears in transcripts or provider consoles: lower-cased, without a
 * context tag such as "[1m]", a provider prefix ("anthropic.", "us.anthropic."), a "-v1:0" version, a date suffix
 * ("-20251001" or "@20251101") or the "-0" alias. Null when the family is not in the table.
 */
export function modelFamily(modelId: string, table: Record<string, Price> = PRICE_TABLE): string | null {
	const id = normalizeModelId(modelId);
	if (id in table) return id;
	const alias = id.replace(/-0$/, "");
	if (alias in table) return alias;
	// A family override ("opus") also prices ids the table does not list (Phase 7 P7).
	const family = FAMILIES.find((f) => id.includes(f));
	return family && family in table ? family : null;
}

/** Estimated USD for one usage row at `table` (default the built-in one); null for an unknown model. */
export function estimateCost(
	u: Pick<
		UsageRow,
		"model" | "inputTokens" | "outputTokens" | "cacheCreationTokens" | "cacheCreation1hTokens" | "cacheReadTokens"
	>,
	table: Record<string, Price> = PRICE_TABLE,
): number | null {
	const family = modelFamily(u.model, table);
	if (family === null) return null;
	const p = table[family];
	const oneHour = Math.min(u.cacheCreation1hTokens, u.cacheCreationTokens);
	return (
		(u.inputTokens * p.input +
			u.outputTokens * p.output +
			(u.cacheCreationTokens - oneHour) * p.cacheWrite +
			oneHour * p.cacheWrite1h +
			u.cacheReadTokens * p.cacheRead) /
		1e6
	);
}

const FAMILIES = ["fable", "mythos", "opus", "sonnet", "haiku"];

/** Display name of a model's family ("Opus", "Sonnet", …); the id itself when no family is recognised. */
export function modelLabel(modelId: string): string {
	const id = modelId.toLowerCase();
	const family = FAMILIES.find((f) => id.includes(f));
	return family ? family[0].toUpperCase() + family.slice(1) : modelId;
}

// ---- Pricing overrides (Phase 7 P7, feature 02) ----

/** $ per million tokens for a model id or a family; missing cache prices follow input as in the built-in rows. */
export type PriceOverride = {
	input: number;
	output: number;
	cacheWrite?: number;
	cacheWrite1h?: number;
	cacheRead?: number;
};

const FAMILY_KEYS = new Set(FAMILIES);

function toPrice(o: PriceOverride): Price {
	return {
		...price(o.input, o.output),
		...(o.cacheWrite === undefined ? {} : { cacheWrite: o.cacheWrite }),
		...(o.cacheWrite1h === undefined ? {} : { cacheWrite1h: o.cacheWrite1h }),
		...(o.cacheRead === undefined ? {} : { cacheRead: o.cacheRead }),
	};
}

/**
 * PRICE_TABLE with the overrides merged over it: a family key ("opus") replaces every id of that family and is kept
 * as its own row (for ids the table does not list); a model-id key then replaces or adds that id.
 */
export function effectivePriceTable(overrides: Record<string, PriceOverride>): Record<string, Price> {
	const table: Record<string, Price> = { ...PRICE_TABLE };
	// Keys are normalized like usage ids, so an id copied from the Costs table (dated, prefixed) still matches.
	const entries = Object.entries(overrides).map(([k, v]) => [normalizeModelId(k), v] as const);
	for (const [key, o] of entries) {
		if (!FAMILY_KEYS.has(key)) continue;
		const p = toPrice(o);
		for (const id of Object.keys(table)) if (id.includes(key)) table[id] = p;
		table[key] = p;
	}
	for (const [key, o] of entries) if (!FAMILY_KEYS.has(key)) table[key] = toPrice(o);
	return table;
}

/** JSON with object keys sorted at every level, so the version ignores key order. */
function sortedJson(v: unknown): string {
	if (v === null || typeof v !== "object") return JSON.stringify(v);
	const o = v as Record<string, unknown>;
	return `{${Object.keys(o)
		.sort()
		.map((k) => `${JSON.stringify(k)}:${sortedJson(o[k])}`)
		.join(",")}}`;
}

/** PRICE_TABLE_VERSION, or PRICE_TABLE_VERSION+<8 hex of the sorted overrides> when there are any. */
export function effectivePriceVersion(overrides: Record<string, PriceOverride>): string {
	if (Object.keys(overrides).length === 0) return PRICE_TABLE_VERSION;
	return `${PRICE_TABLE_VERSION}+${createHash("sha256").update(sortedJson(overrides)).digest("hex").slice(0, 8)}`;
}

/**
 * Claude subscription prices for the Costs run-rate line (Phase 7 P6, U5), USD per month, with the date they were
 * checked. Information only: the tracker never says which plan the user has.
 */
export const PLAN_PRICES: { asOf: string; plans: { name: string; usd: number }[] } = {
	asOf: "2026-10-17",
	plans: [
		{ name: "Pro", usd: 20 },
		{ name: "Max 5x", usd: 100 },
		{ name: "Max 20x", usd: 200 },
	],
};

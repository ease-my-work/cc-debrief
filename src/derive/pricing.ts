// The effective price table (Phase 7 P7): PRICE_TABLE with config.json's pricing.overrides merged over it. Read from
// the config on each call (derive runs in short CLI processes and in the dashboard, where Settings can change it);
// the merged table is memoized per distinct overrides.
import { effectivePriceTable, effectivePriceVersion, type Price, type PriceOverride } from "../collector/prices";
import { loadConfig } from "../config";

let memo: { key: string; table: Record<string, Price>; version: string } | null = null;

/** The table derive prices usage rows with, and its version (stored in each session's derive state). */
export function activePricing(overrides: Record<string, PriceOverride> = loadConfig().pricing.overrides): {
	table: Record<string, Price>;
	version: string;
} {
	const key = JSON.stringify(overrides);
	if (memo?.key !== key) {
		memo = { key, table: effectivePriceTable(overrides), version: effectivePriceVersion(overrides) };
	}
	return memo;
}

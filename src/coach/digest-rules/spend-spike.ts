// Digest rule 5, spend spike (Phase 7 P5, U1): a local day in the last 7 whose spend is at least 2× the median of the
// previous 14 active days (days with spend) and at least $5. Spend per day is the Costs view's (session totals spread
// over their usage days), so the item matches the chart; the tracker's own calls are not in it.

import type { Db } from "../../db/adapter";
import { costInputs, spreadCost } from "../../db/queries/costs";
import { localDate } from "../../db/queries/range";
import type { DigestRule, Finding } from "../types";
import { daysBefore } from "./shared";

const FACTOR = 2;
const MIN_USD = 5;
const PRIOR_DAYS = 14;
const CHECK_DAYS = 7;
/** How far back the usual days are looked for: sparse users still reach 14 active days. */
const LOOKBACK_DAYS = 180;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const median = (xs: number[]) => {
	const s = [...xs].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const usd = (n: number) => `$${n.toFixed(2)}`;
const round = (n: number) => Math.round(n * 1e6) / 1e6;

export type Spike = { day: string; date: Date; usd: number; median: number; tokens: number };

/** Local days among the last `checkDays` whose spend meets U1 against the 14 active days before each. */
export function findSpikes(db: Db, now: Date, checkDays: number = CHECK_DAYS): Spike[] {
	const from = daysBefore(now, LOOKBACK_DAYS + checkDays);
	const { totals, sessions, bySession } = costInputs(db, {
		sql: "SELECT session_id FROM sessions WHERE started_at >= ?",
		params: [from],
	});
	const spend = new Map<string, number>();
	spreadCost(sessions, totals, bySession, now, (iso, _label, usd) => {
		const day = localDate(new Date(iso));
		spend.set(day, (spend.get(day) ?? 0) + usd);
	});
	const tokens = new Map<string, number>();
	for (const r of db
		.prepare(
			`SELECT ts, input_tokens + output_tokens + cache_creation_tokens + cache_read_tokens AS n FROM usage
				 WHERE ts >= ?`,
		)
		.all<{ ts: string; n: number }>(daysBefore(now, checkDays + 1))) {
		const day = localDate(new Date(r.ts));
		tokens.set(day, (tokens.get(day) ?? 0) + r.n);
	}

	const active = [...spend.entries()].filter(([, v]) => v > 0).sort(([a], [b]) => a.localeCompare(b));
	const out: Spike[] = [];
	for (let back = checkDays - 1; back >= 0; back--) {
		const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back);
		const day = localDate(date);
		const value = spend.get(day) ?? 0;
		if (value < MIN_USD) continue;
		const prior = active.filter(([d]) => d < day).slice(-PRIOR_DAYS);
		if (prior.length < PRIOR_DAYS) continue;
		const usual = median(prior.map(([, v]) => v));
		if (value < FACTOR * usual) continue;
		out.push({ day, date, usd: round(value), median: round(usual), tokens: tokens.get(day) ?? 0 });
	}
	return out;
}

export const spendSpike: DigestRule = {
	rule: "spend_spike",
	run(db, now) {
		return findSpikes(db, now).map(
			(s): Finding => ({
				rule: this.rule,
				severity: "low",
				message: `${WEEKDAYS[s.date.getDay()]} cost ${usd(s.usd)} vs usual ${usd(s.median)} a day`,
				evidence: { key: s.day, day: s.day, usd: s.usd, median: s.median },
				costTokens: s.tokens,
				target: "overview",
				// The spike day, so an old spike never lands in this week's digest.
				at: s.date.toISOString(),
			}),
		);
	},
};

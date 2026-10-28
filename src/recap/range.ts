// Recap ranges (feature 17 "Ranges"): CLI flags or API query → inclusive local calendar days, and their half-open
// [from 00:00, to + 1 day 00:00) bounds as UTC ISO strings. Days follow the machine's local time zone.
import { localDate } from "../db/queries/range";
import type { RangeInput, RecapRange } from "./types";

/** An invalid range; the message is shown as is by the CLI (exit 2) and the API (400 invalid_range). */
export class RecapRangeError extends RangeError {
	override name = "RecapRangeError";
}

const MAX_DAYS = 366;
const CONFLICT = "use one of --today, --yesterday, --date, --week, --from";
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Local midnight of a YYYY-MM-DD date, plus `addDays`. */
function midnight(date: string, addDays = 0): Date {
	const [, y, m, d] = DATE.exec(date) as RegExpExecArray;
	return new Date(Number(y), Number(m) - 1, Number(d) + addDays);
}

function checkDate(date: string): string {
	const m = DATE.exec(date);
	if (!m || localDate(midnight(date)) !== date) throw new RecapRangeError(`invalid date "${date}"`);
	return date;
}

/** Throws RecapRangeError on a malformed date, from after to, more than 366 days, or more than one range input. */
export function resolveRange(input: RangeInput, now: Date = new Date()): RecapRange {
	const picks = [input.range, input.date, input.from].filter((v) => v !== undefined).length;
	if (picks > 1 || (input.to !== undefined && input.from === undefined)) throw new RecapRangeError(CONFLICT);
	const today = localDate(now);
	const shift = (days: number) => localDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() + days));
	if (input.date !== undefined) {
		const d = checkDate(input.date);
		return { from: d, to: d };
	}
	if (input.from !== undefined) {
		const from = checkDate(input.from);
		const to = input.to === undefined ? today : checkDate(input.to);
		if (from > to) throw new RecapRangeError("from is after to");
		// Calendar days, counted at noon so a DST change never rounds a day away.
		const days = Math.round((midnight(to).setHours(12) - midnight(from).setHours(12)) / 86_400_000) + 1;
		if (days > MAX_DAYS) throw new RecapRangeError(`range longer than ${MAX_DAYS} days`);
		return { from, to };
	}
	if (input.range === "yesterday") {
		const d = shift(-1);
		return { from: d, to: d };
	}
	if (input.range === "week") return { from: shift(-6), to: today };
	return { from: today, to: today };
}

/** UTC ISO strings of the range's local midnights: [from 00:00, to + 1 day 00:00). */
export function rangeBounds(r: RecapRange): { fromIso: string; toIso: string } {
	return { fromIso: midnight(r.from).toISOString(), toIso: midnight(r.to, 1).toISOString() };
}

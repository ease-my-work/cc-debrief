// Dashboard date ranges (feature 12): "today" = since local midnight; 7d, 30d and 90d = rolling windows ending now;
// "all" = everything still retained (Phase 7 P1).
import type { Range } from "../../server/types";
import type { Db } from "../adapter";

const DAY_MS = 86_400_000;
const WINDOW_DAYS: Record<Exclude<Range, "today" | "all">, number> = { "7d": 7, "30d": 30, "90d": 90 };
/** Day-bucket views show at most this many days (Phase 7 spec decision 3). */
export const MAX_DAY_BUCKETS = 366;

/** ISO start of the range; "" for all, which every ISO time sorts after (so `started_at >= ?` keeps every row). */
export function rangeStart(range: Range, now: Date): string {
	if (range === "today") return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
	if (range === "all") return "";
	return new Date(now.getTime() - WINDOW_DAYS[range] * DAY_MS).toISOString();
}

/** The range as bounds; `from` is null for all (no lower bound). */
export function rangeBounds(_db: Db, range: Range, now: Date): { from: string | null; to: string } {
	return { from: range === "all" ? null : rangeStart(range, now), to: now.toISOString() };
}

/** The local calendar date (YYYY-MM-DD) of a time. */
export function localDate(d: Date): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Local midnight of `now`'s day minus `back` days (calendar arithmetic, so DST never skips or repeats a day). */
const dayBack = (now: Date, back: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - back);

/** Started_at of the oldest retained session, or null on an empty database. */
export function oldestStart(db: Db): string | null {
	return db.prepare("SELECT min(started_at) AS m FROM sessions").get<{ m: string | null }>()?.m ?? null;
}

/**
 * Local dates from `from`'s day (null: the oldest retained session's day, else today) to today, oldest first, cut to
 * the newest MAX_DAY_BUCKETS days (`truncated` says so).
 */
export function dayBuckets(from: string | null, now: Date, db?: Db): { days: string[]; truncated: boolean } {
	const start = from ?? (db ? oldestStart(db) : null);
	const today = dayBack(now, 0);
	let span = 0;
	if (start) {
		const s = new Date(start);
		const first = new Date(s.getFullYear(), s.getMonth(), s.getDate());
		// Round: a DST day is 23 or 25 hours long.
		span = Math.max(0, Math.round((today.getTime() - first.getTime()) / DAY_MS));
	}
	const truncated = span + 1 > MAX_DAY_BUCKETS;
	const n = Math.min(span + 1, MAX_DAY_BUCKETS);
	const days: string[] = [];
	for (let i = n - 1; i >= 0; i--) days.push(localDate(dayBack(now, i)));
	return { days, truncated };
}

/** The local dates a range's chart shows, oldest first: 1, 7, 30 or 90 days ending today; all needs the DB. */
export function rangeDays(range: Range, now: Date, db?: Db): string[] {
	if (range === "all") return dayBuckets(null, now, db).days;
	const n = range === "today" ? 1 : WINDOW_DAYS[range];
	const out: string[] = [];
	for (let i = n - 1; i >= 0; i--) out.push(localDate(dayBack(now, i)));
	return out;
}

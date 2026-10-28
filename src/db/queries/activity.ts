// GET /api/activity (Phase 7 P2, feature 18): the last 365 local days as a heatmap (U4; days before the oldest
// retained session are "not retained"), streaks over every retained day, and the range's active days, sessions by
// local hour and weekday, and the share of sessions with a compaction. Sessions count on their start day; heatmap
// tokens are the usage rows of the day (10-minute UTC buckets, exact for half-hour zones).
import type { ActivityResponse, Range } from "../../server/types";
import type { Db } from "../adapter";
import { localDate, oldestStart, rangeStart } from "./range";

const HEATMAP_DAYS = 365;

const dayBack = (now: Date, back: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - back);

/** The longest run of consecutive calendar days in a sorted list of local dates, and the run ending at `last`. */
function streaks(activeDays: Set<string>, now: Date): { current: number; longest: number } {
	const sorted = [...activeDays].sort();
	let longest = 0;
	let run = 0;
	let prev: string | null = null;
	for (const d of sorted) {
		if (prev !== null) {
			const [y, m, dd] = prev.split("-").map(Number);
			run = localDate(new Date(y, m - 1, dd + 1)) === d ? run + 1 : 1;
		} else run = 1;
		if (run > longest) longest = run;
		prev = d;
	}
	// Current: ending today, or ending yesterday while today has no session yet.
	let back = activeDays.has(localDate(dayBack(now, 0))) ? 0 : 1;
	let current = 0;
	while (activeDays.has(localDate(dayBack(now, back)))) {
		current++;
		back++;
	}
	return { current, longest };
}

export function getActivity(db: Db, opts: { range: Range; now: Date }): ActivityResponse {
	const { now } = opts;
	const first = dayBack(now, HEATMAP_DAYS - 1);
	const firstDay = localDate(first);

	// Every session's start (for streaks and the heatmap): one row per session, converted to a local day once.
	const starts = db
		.prepare("SELECT started_at FROM sessions WHERE started_at IS NOT NULL")
		.all<{ started_at: string }>();
	const perDay = new Map<string, number>();
	for (const s of starts) {
		const d = localDate(new Date(s.started_at));
		perDay.set(d, (perDay.get(d) ?? 0) + 1);
	}

	const tokens = new Map<string, number>();
	for (const r of db
		.prepare(
			`SELECT substr(ts, 1, 15) AS b,
			   sum(input_tokens + output_tokens + cache_creation_tokens + cache_read_tokens) AS n
			 FROM usage WHERE ts >= ? GROUP BY b`,
		)
		.all<{ b: string; n: number }>(first.toISOString())) {
		const d = localDate(new Date(`${r.b}0:00.000Z`));
		tokens.set(d, (tokens.get(d) ?? 0) + r.n);
	}

	const oldest = oldestStart(db);
	const oldestDay = oldest ? localDate(new Date(oldest)) : null;
	const days: ActivityResponse["days"] = [];
	for (let back = HEATMAP_DAYS - 1; back >= 0; back--) {
		const date = localDate(dayBack(now, back));
		days.push({
			date,
			sessions: perDay.get(date) ?? 0,
			tokens: tokens.get(date) ?? 0,
			retained: oldestDay !== null && date >= oldestDay,
		});
	}

	// The range's stats.
	const inRange = db
		.prepare(
			`SELECT s.started_at, EXISTS (SELECT 1 FROM compactions c WHERE c.session_id = s.session_id) AS compacted
			 FROM sessions s WHERE s.started_at >= ?`,
		)
		.all<{ started_at: string; compacted: number }>(rangeStart(opts.range, now));
	const byHour = Array.from({ length: 24 }, () => 0);
	const byWeekday = Array.from({ length: 7 }, () => 0);
	const active = new Set<string>();
	let compacted = 0;
	for (const s of inRange) {
		const d = new Date(s.started_at);
		byHour[d.getHours()]++;
		byWeekday[d.getDay()]++;
		active.add(localDate(d));
		compacted += s.compacted ? 1 : 0;
	}

	return {
		days,
		streak: streaks(new Set(perDay.keys()), now),
		activeDays: active.size,
		byHour,
		byWeekday,
		compactedShare: inRange.length > 0 ? compacted / inRange.length : 0,
		sessions: inRange.length,
		truncated: opts.range === "all" && oldestDay !== null && oldestDay < firstDay,
	};
}

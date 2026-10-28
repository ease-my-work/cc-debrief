// Phase 7 Task 8 (P2): getActivity() — the 365-day heatmap (U4), streaks, active days, hours and weekdays in local
// time, the compacted share. `npm run test:tz` runs it in UTC, Asia/Kolkata and America/Los_Angeles.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../../../src/db/adapter";
import { migrate } from "../../../src/db/migrate";
import { getActivity } from "../../../src/db/queries/activity";
import { localDate } from "../../../src/db/queries/range";
import { localAt, PARITY_NOW, seedParitySession } from "../../helpers/parity-seed";

let db: Db;
beforeEach(() => {
	db = openDb(":memory:");
	migrate(db);
});
afterEach(() => db.close());

let n = 0;
const at = (d: Date, o: { tokens?: number; compactions?: number } = {}) =>
	seedParitySession(db, `s${n++}`, {
		startedAt: d.toISOString(),
		usage: [{ input: o.tokens ?? 100, ts: d.toISOString() }],
		compactions: o.compactions,
	});
const daysAgo = (k: number, h = 10) => new Date(localAt(k, h));

describe("getActivity", () => {
	it("the heatmap is the last 365 local days, not retained before the oldest session", () => {
		at(daysAgo(10), { tokens: 500 });
		at(daysAgo(10, 18), { tokens: 250 });
		at(daysAgo(0));
		const a = getActivity(db, { range: "7d", now: PARITY_NOW });
		expect(a.days).toHaveLength(365);
		expect(a.days.at(-1)).toMatchObject({ date: "2026-10-17", sessions: 1, tokens: 100, retained: true });
		expect(a.days.find((d) => d.date === "2026-10-07")).toEqual({
			date: "2026-10-07",
			sessions: 2,
			tokens: 750,
			retained: true,
		});
		expect(a.days.find((d) => d.date === "2026-10-06")?.retained).toBe(false);
		expect(a.days.find((d) => d.date === "2026-10-08")).toEqual({
			date: "2026-10-08",
			sessions: 0,
			tokens: 0,
			retained: true,
		});
		expect(a.truncated).toBe(false);
	});

	it("streaks are calendar days across a DST change", () => {
		const now = new Date(2026, 2, 20, 21); // DST starts 2026-03-08 in Los Angeles
		for (let d = 1; d <= 20; d++) at(new Date(2026, 2, d, 0, 30));
		expect(getActivity(db, { range: "30d", now }).streak).toEqual({ current: 20, longest: 20 });
	});

	it("today without a session keeps yesterday's streak as current", () => {
		for (const k of [1, 2, 3]) at(daysAgo(k));
		expect(getActivity(db, { range: "7d", now: PARITY_NOW }).streak.current).toBe(3);
		const tomorrow = new Date(2026, 9, 18, 0, 1); // midnight passed with no session on the 17th
		expect(getActivity(db, { range: "7d", now: tomorrow }).streak.current).toBe(0);
	});

	it("a gap breaks the current streak; the longest is kept", () => {
		for (const k of [20, 19, 18, 17, 16]) at(daysAgo(k));
		for (const k of [1, 0]) at(daysAgo(k));
		expect(getActivity(db, { range: "30d", now: PARITY_NOW }).streak).toEqual({ current: 2, longest: 5 });
	});

	it("counts the range's sessions by local hour and weekday, active days and the compacted share", () => {
		at(daysAgo(0, 9));
		at(daysAgo(0, 9), { compactions: 2 });
		at(daysAgo(1, 23));
		at(daysAgo(30, 9)); // outside 7d
		const a = getActivity(db, { range: "7d", now: PARITY_NOW });
		expect(a.sessions).toBe(3);
		expect(a.activeDays).toBe(2);
		expect(a.byHour[9]).toBe(2);
		expect(a.byHour[23]).toBe(1);
		expect(a.byHour.reduce((x, y) => x + y, 0)).toBe(3);
		const sat = new Date(2026, 9, 17).getDay();
		expect(a.byWeekday[sat]).toBe(2);
		expect(a.byWeekday[(sat + 6) % 7]).toBe(1);
		expect(a.compactedShare).toBeCloseTo(1 / 3, 6);
		// The heatmap does not follow the range.
		expect(a.days.filter((d) => d.sessions > 0)).toHaveLength(3);
	});

	it("all: truncated when retained sessions are older than the heatmap", () => {
		at(daysAgo(400));
		at(daysAgo(0));
		const a = getActivity(db, { range: "all", now: PARITY_NOW });
		expect(a.truncated).toBe(true);
		expect(a.sessions).toBe(2);
		expect(a.days[0].date).toBe(localDate(new Date(2026, 9, 17 - 364)));
	});

	it("an empty database has empty days, no streak and zero shares", () => {
		const a = getActivity(db, { range: "30d", now: PARITY_NOW });
		expect(a.days.every((d) => d.sessions === 0 && !d.retained)).toBe(true);
		expect(a).toMatchObject({ streak: { current: 0, longest: 0 }, activeDays: 0, sessions: 0, compactedShare: 0 });
		expect(a.byHour).toHaveLength(24);
		expect(a.byWeekday).toHaveLength(7);
	});
});

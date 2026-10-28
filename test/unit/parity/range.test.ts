// Phase 7 Task 3 (P1): the 90d and all ranges. `npm run test:tz -- test/unit/parity` runs this under UTC,
// Asia/Kolkata and America/Los_Angeles; NOW is a local time, so each expectation holds in every zone.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../../../src/db/adapter";
import { migrate } from "../../../src/db/migrate";
import { dayBuckets, localDate, rangeBounds, rangeDays, rangeStart } from "../../../src/db/queries/range";

const NOW = new Date(2026, 9, 17, 15, 30); // 2026-10-17 15:30 local
const DAY = 86_400_000;

let db: Db;
beforeEach(() => {
	db = openDb(":memory:");
	migrate(db);
});
afterEach(() => db.close());

const addSession = (id: string, startedAt: string) =>
	db.prepare("INSERT INTO sessions (session_id, started_at) VALUES (?, ?)").run(id, startedAt);

describe("rangeBounds", () => {
	it("today starts at local midnight", () => {
		expect(rangeBounds(db, "today", NOW)).toEqual({
			from: new Date(2026, 9, 17).toISOString(),
			to: NOW.toISOString(),
		});
	});
	it.each([
		["7d", 7],
		["30d", 30],
		["90d", 90],
	] as const)("%s is a rolling window of %i days", (range, days) => {
		expect(rangeBounds(db, range, NOW).from).toBe(new Date(NOW.getTime() - days * DAY).toISOString());
	});
	it("all has no lower bound", () => {
		addSession("old", new Date(2025, 0, 1).toISOString());
		expect(rangeBounds(db, "all", NOW)).toEqual({ from: null, to: NOW.toISOString() });
	});
	it("rangeStart(all) sorts before every ISO time, so started_at >= ? keeps every row", () => {
		addSession("old", "1999-01-01T00:00:00.000Z");
		const n = db
			.prepare("SELECT count(*) AS n FROM sessions WHERE started_at >= ?")
			.get<{ n: number }>(rangeStart("all", NOW))?.n;
		expect(n).toBe(1);
	});
});

describe("dayBuckets", () => {
	it("all on an empty database is just today", () => {
		expect(dayBuckets(null, NOW, db)).toEqual({ days: ["2026-10-17"], truncated: false });
	});
	it("all starts at the oldest retained session's local day", () => {
		addSession("a", new Date(2026, 9, 14, 23, 50).toISOString());
		addSession("b", new Date(2026, 9, 16, 8).toISOString());
		expect(dayBuckets(null, NOW, db)).toEqual({
			days: ["2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17"],
			truncated: false,
		});
	});
	it("a 400-day database gives the newest 366 days and says it was cut", () => {
		addSession("old", new Date(2026, 9, 17 - 399, 12).toISOString());
		const b = dayBuckets(null, NOW, db);
		expect(b.days).toHaveLength(366);
		expect(b.truncated).toBe(true);
		expect(b.days.at(-1)).toBe("2026-10-17");
		expect(b.days[0]).toBe(localDate(new Date(2026, 9, 17 - 365)));
	});
	it("90d from a bound gives one bucket per local day, oldest first", () => {
		const b = dayBuckets(rangeBounds(db, "90d", NOW).from, NOW);
		expect(b.days).toHaveLength(91); // the start day (part of it) through today
		expect(b.days[0]).toBe(localDate(new Date(NOW.getTime() - 90 * DAY)));
		expect(b.truncated).toBe(false);
	});
	it("days are calendar days across a DST change (no duplicate, no gap)", () => {
		const b = dayBuckets(new Date(2026, 2, 1).toISOString(), new Date(2026, 3, 30, 12));
		expect(new Set(b.days).size).toBe(b.days.length);
		expect(b.days).toHaveLength(61); // March 31 + April 30
	});
});

describe("rangeDays (the Overview chart)", () => {
	it("90d shows 90 days ending today", () => {
		const d = rangeDays("90d", NOW);
		expect(d).toHaveLength(90);
		expect(d.at(-1)).toBe("2026-10-17");
	});
});

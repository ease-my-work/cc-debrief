// Phase 6 Task 3. `npm run test:tz` runs this file under UTC, Asia/Kolkata and America/Los_Angeles; `now` is a local
// time, so every expectation below holds in each zone.
import { describe, expect, it } from "vitest";
import { RecapRangeError, rangeBounds, resolveRange } from "../../../src/recap/range";

const NOW = new Date(2026, 8, 28, 10, 0); // 2026-09-28 10:00 local
const day = (d: string) => ({ from: d, to: d });
const err = (fn: () => unknown): string => {
	try {
		fn();
	} catch (e) {
		expect(e).toBeInstanceOf(RecapRangeError);
		return (e as Error).message;
	}
	throw new Error("expected a RecapRangeError");
};

describe("resolveRange", () => {
	it("defaults to today", () => {
		expect(resolveRange({}, NOW)).toEqual(day("2026-09-28"));
		expect(resolveRange({ range: "today" }, NOW)).toEqual(day("2026-09-28"));
	});
	it("yesterday", () => expect(resolveRange({ range: "yesterday" }, NOW)).toEqual(day("2026-09-27")));
	it("a date", () => expect(resolveRange({ date: "2026-09-11" }, NOW)).toEqual(day("2026-09-11")));
	it("week: today and the 6 days before it", () =>
		expect(resolveRange({ range: "week" }, NOW)).toEqual({ from: "2026-09-22", to: "2026-09-28" }));
	it("from without to runs to today", () =>
		expect(resolveRange({ from: "2026-09-01" }, NOW)).toEqual({ from: "2026-09-01", to: "2026-09-28" }));
	it("from and to", () =>
		expect(resolveRange({ from: "2026-09-01", to: "2026-09-10" }, NOW)).toEqual({
			from: "2026-09-01",
			to: "2026-09-10",
		}));
	it("future dates are allowed", () => expect(resolveRange({ date: "2027-01-01" }, NOW)).toEqual(day("2027-01-01")));
	it("week across a month boundary", () =>
		expect(resolveRange({ range: "week" }, new Date(2026, 9, 2, 8))).toEqual({ from: "2026-09-26", to: "2026-10-02" }));

	it("from after to", () =>
		expect(err(() => resolveRange({ from: "2026-09-10", to: "2026-09-01" }, NOW))).toBe("from is after to"));
	it.each(["2026-02-30", "2026-13-01", "26-09-01", "2026-9-1", "yesterday", ""])("invalid date %j", (d) =>
		expect(err(() => resolveRange({ date: d }, NOW))).toBe(`invalid date "${d}"`),
	);
	it("an invalid from or to", () => {
		expect(err(() => resolveRange({ from: "2026-02-30" }, NOW))).toBe('invalid date "2026-02-30"');
		expect(err(() => resolveRange({ from: "2026-02-01", to: "x" }, NOW))).toBe('invalid date "x"');
	});
	it("longer than 366 days", () => {
		expect(err(() => resolveRange({ from: "2025-01-01", to: "2026-09-28" }, NOW))).toBe("range longer than 366 days");
		// 366 days inclusive is allowed
		expect(resolveRange({ from: "2025-09-28", to: "2026-09-28" }, NOW)).toEqual({
			from: "2025-09-28",
			to: "2026-09-28",
		});
		expect(err(() => resolveRange({ from: "2025-09-27", to: "2026-09-28" }, NOW))).toBe("range longer than 366 days");
	});
	it.each([
		{ range: "week", date: "2026-09-11" },
		{ range: "today", from: "2026-09-01" },
		{ date: "2026-09-11", from: "2026-09-01" },
		{ to: "2026-09-10" },
		{ date: "2026-09-11", to: "2026-09-12" },
	] as const)("conflicting inputs %j", (input) =>
		expect(err(() => resolveRange(input, NOW))).toBe("use one of --today, --yesterday, --date, --week, --from"),
	);
});

describe("rangeBounds", () => {
	it("a day runs from local midnight to the next local midnight", () => {
		const { fromIso, toIso } = rangeBounds(day("2026-09-28"));
		const from = new Date(fromIso);
		const to = new Date(toIso);
		expect([from.getFullYear(), from.getMonth(), from.getDate(), from.getHours(), from.getMinutes()]).toEqual([
			2026, 8, 28, 0, 0,
		]);
		expect([to.getDate(), to.getHours(), to.getMinutes()]).toEqual([29, 0, 0]);
		expect(toIso.endsWith("Z")).toBe(true);
	});
	it("a week ends after its last day", () => {
		const { fromIso, toIso } = rangeBounds({ from: "2026-09-22", to: "2026-09-28" });
		expect(new Date(fromIso).getDate()).toBe(22);
		expect(new Date(toIso).getDate()).toBe(29);
	});
	it.runIf(process.env.TZ === "America/Los_Angeles")("DST start in Los Angeles is a 23-hour day", () => {
		const { fromIso, toIso } = rangeBounds(day("2026-03-08"));
		expect((Date.parse(toIso) - Date.parse(fromIso)) / 3_600_000).toBe(23);
		expect(new Date(fromIso).getHours()).toBe(0);
		expect(new Date(toIso).getHours()).toBe(0);
	});
});

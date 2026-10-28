import { describe, expect, it } from "vitest";
import {
	compactTokens,
	duration,
	modelFamily,
	num,
	relTime,
	shortId,
	signed,
	tokenText,
	usd,
	when,
} from "../../ui/src/lib/format";

// Local wall-clock times, so the tests hold in any time zone.
const local = (m: number, d: number, h = 0, min = 0) => new Date(2026, m - 1, d, h, min).toISOString();
const NOW = new Date(2026, 9, 2, 15, 30); // Fri 2 Oct 2026 15:30 local

describe("compactTokens", () => {
	it.each([
		[0, "0"],
		[950, "950"],
		[999, "999"],
		[1_000, "1.0k"],
		[9_950, "9.9k"],
		[10_000, "10k"],
		[388_000, "388k"],
		[999_499, "999k"],
		[999_999, "999k"],
		[1_000_000, "1.0M"],
		[3_899_999, "3.8M"],
		[3_800_000, "3.8M"],
		[12_400_000, "12M"],
	])("%d → %s", (n, s) => expect(compactTokens(n)).toBe(s));
});

describe("usd", () => {
	it("formats two decimals and a dash for unknown", () => {
		expect(usd(18.4)).toBe("$18.40");
		expect(usd(0)).toBe("$0.00");
		expect(usd(1234.5)).toBe("$1,234.50");
		expect(usd(null)).toBe("—");
	});
});

describe("duration", () => {
	it("formats hours and minutes, running for an open session", () => {
		expect(duration(4320)).toBe("1h 12m");
		expect(duration(1440)).toBe("24m");
		expect(duration(3600)).toBe("1h 0m");
		expect(duration(30)).toBe("<1m");
		expect(duration(null)).toBe("running");
	});
});

describe("when", () => {
	it("shows a time today, Yesterday, a weekday within 7 days, else a date", () => {
		expect(when(local(10, 2, 14, 2), NOW)).toBe("14:02");
		expect(when(local(10, 1, 23, 59), NOW)).toBe("Yesterday");
		expect(when(local(9, 29, 10), NOW)).toBe("Tue");
		expect(when(local(9, 26, 10), NOW)).toBe("Sat");
		expect(when(local(9, 25, 10), NOW)).toBe("25 Sep");
	});

	it("rolls over at local midnight", () => {
		const justAfter = new Date(2026, 9, 3, 0, 1);
		expect(when(local(10, 3, 0, 0), justAfter)).toBe("00:00");
		expect(when(local(10, 2, 23, 59), justAfter)).toBe("Yesterday");
	});
});

describe("modelFamily", () => {
	it("labels families and shows a switch", () => {
		expect(modelFamily(["claude-opus-4-1"])).toBe("Opus");
		expect(modelFamily(["claude-opus-4-1", "claude-sonnet-4-5"])).toBe("Opus → Sonnet");
		expect(modelFamily(["claude-haiku-4-5", "claude-haiku-4-5-20251001"])).toBe("Haiku");
		expect(modelFamily(["mystery-1"])).toBe("mystery-1");
		expect(modelFamily([])).toBe("—");
	});
});

describe("ids, times and numbers", () => {
	it("shortens session ids", () => {
		expect(shortId("a3f9b7d2-0000-4000-8000-00000000c21e")).toBe("a3f9…c21e");
		expect(shortId("short")).toBe("short");
	});

	it("gives relative times", () => {
		const at = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
		expect(relTime(at(20_000), NOW)).toBe("just now");
		expect(relTime(at(2 * 60_000), NOW)).toBe("2 min ago");
		expect(relTime(at(3 * 3_600_000), NOW)).toBe("3 h ago");
		expect(relTime(at(2 * 86_400_000), NOW)).toBe("2 days ago");
		expect(relTime(null, NOW)).toBe("never");
	});

	it("groups digits and signs line counts", () => {
		expect(num(2140)).toBe("2,140");
		expect(signed(2140, "+")).toBe("+2,140");
		expect(signed(860, "-")).toBe("−860");
	});
});

describe("tokenText", () => {
	it("says tokens unknown without usage rows, marks a counted total, else compacts", () => {
		expect(tokenText({ tokens: 0, partial: true, tokensUnknown: true })).toBe("tokens unknown");
		expect(tokenText({ tokens: 12_400, partial: true, tokensUnknown: false })).toBe("≥ 12k");
		expect(tokenText({ tokens: 12_400, partial: false, tokensUnknown: false })).toBe("12k");
	});
});

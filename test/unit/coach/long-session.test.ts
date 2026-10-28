import { describe, expect, it } from "vitest";
import { longSession } from "../../../src/coach/signals/long-session";
import type { SessionContext } from "../../../src/coach/types";
import { at, compaction, ctx, turn, usage } from "../../helpers/ctx";

/** n turns spread evenly over `minutes`, with usage totalling 1000 input-side tokens at the given cache share. */
function session(o: { minutes: number; seconds?: number; turns?: number; share?: number; median?: number | null }) {
	const n = o.turns ?? 10;
	const end = at(o.minutes, o.seconds ?? 0);
	const turns = Array.from({ length: n }, (_, i) => turn(i + 1, `p${i + 1}`, at((i * o.minutes) / n)));
	const share = o.share ?? 0.54;
	const rows = [usage(1, { input: Math.round((1 - share) * 1000), cacheRead: Math.round(share * 1000), output: 77 })];
	return ctx({
		turns,
		usage: rows,
		session: {
			sessionId: "s",
			startedAt: at(0),
			endedAt: end,
			cwd: null,
			repoId: null,
			headEnd: null,
			sessionType: null,
		},
		userMedianCacheShare: o.median === undefined ? 0.78 : o.median,
	});
}

const detect = (c: SessionContext) => longSession.detect(c);

describe("long_session_no_compaction", () => {
	it("does not fire at exactly 2 h (strictly greater)", () => {
		expect(detect(session({ minutes: 120 }))).toEqual([]);
	});

	it("fires at 2 h 0 m 1 s with the spec message, cost and evidence", () => {
		const [f] = detect(session({ minutes: 120, seconds: 1 }));
		expect(f).toEqual({
			rule: "long_session_no_compaction",
			// 78 − 54 = 24 points: high per feature 07 (the plan's table says medium for this case; feature 07 rules).
			severity: "high",
			message: "Long session with no compaction — cache hit 54% vs your usual 78%; split it or `/compact`",
			evidence: { wallMinutes: 120, turns: 10, share: 0.54, median: 0.78 },
			costTokens: 240,
			target: "session",
		});
	});

	it("fires on 41 turns in 30 minutes and not on 40", () => {
		expect(detect(session({ minutes: 30, turns: 41 }))).toHaveLength(1);
		expect(detect(session({ minutes: 30, turns: 40 }))).toEqual([]);
	});

	it("is high when the gap is at least 20 points", () => {
		expect(detect(session({ minutes: 150, share: 0.58 }))[0].severity).toBe("high");
		expect(detect(session({ minutes: 150, share: 0.59 }))[0].severity).toBe("medium");
	});

	it("does not fire when the share is at or above the median", () => {
		expect(detect(session({ minutes: 150, share: 0.78 }))).toEqual([]);
		expect(detect(session({ minutes: 150, share: 0.9 }))).toEqual([]);
	});

	it("does not fire with a compaction", () => {
		expect(detect({ ...session({ minutes: 150 }), compactions: [compaction()] })).toEqual([]);
	});

	it("is skipped without a median", () => {
		expect(detect(session({ minutes: 150, median: null }))).toEqual([]);
	});

	it("does not fire without usage rows (share undefined)", () => {
		expect(
			detect({
				...session({ minutes: 150 }),
				usage: [],
				totals: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, tokens: 0 },
			}),
		).toEqual([]);
	});

	it("leaves out gaps between turns longer than an hour (a session resumed after 10 h with 90 min of turns)", () => {
		const turns = [
			turn(1, "a", at(0)),
			turn(2, "b", at(40)),
			turn(3, "c", at(40 + 600)), // resumed 10 h later
			turn(4, "d", at(40 + 600 + 46)),
		];
		const c = ctx({
			turns,
			usage: [usage(1, { input: 460, cacheRead: 540 })],
			session: {
				sessionId: "s",
				startedAt: at(0),
				endedAt: at(40 + 600 + 48),
				cwd: null,
				repoId: null,
				headEnd: null,
				sessionType: null,
			},
			userMedianCacheShare: 0.78,
		});
		expect(detect(c)).toEqual([]);
	});
});

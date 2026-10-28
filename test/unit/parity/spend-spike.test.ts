// Phase 7 Task 7 (P5): digest rule 5 spend_spike (U1) — a local day ≥ 2× the median of the previous 14 active days
// and ≥ $5; severity low; one finding per day. `npm run test:tz` runs it in three zones.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildDigest, DIGEST_RULES, runDigestRules } from "../../../src/coach/digest";
import { spendSpike } from "../../../src/coach/digest-rules/spend-spike";
import { dismissFinding, recordFeedback } from "../../../src/coach/feedback";
import { type Db, openDb } from "../../../src/db/adapter";
import { migrate } from "../../../src/db/migrate";
import { localAt, PARITY_NOW, seedParitySession } from "../../helpers/parity-seed";

let db: Db;
beforeEach(() => {
	db = openDb(":memory:");
	migrate(db);
});
afterEach(() => db.close());

/** One session per day `daysAgo` with the given cost. */
const day = (daysAgo: number, usd: number, tokens = 1000) =>
	seedParitySession(db, `d${daysAgo}-${usd}`, {
		startedAt: localAt(daysAgo, 11),
		usage: [{ input: tokens, cost: usd }],
	});
/** 14 usual days at $3 a day, ending 8 days ago (before the 7 days the rule checks). */
const usual = (n = 14, usd = 3) => {
	for (let i = 0; i < n; i++) day(8 + i, usd);
};

describe("spend_spike", () => {
	it("is digest rule 5", () => {
		expect(DIGEST_RULES.map((r) => r.rule)).toContain("spend_spike");
	});

	it("fires at exactly 2× the median and $6 (both conditions met)", () => {
		usual();
		day(2, 6, 5000);
		const found = spendSpike.run(db, PARITY_NOW);
		expect(found).toHaveLength(1);
		const [y, m, d] = [2026, 9, 15];
		expect(found[0]).toMatchObject({
			rule: "spend_spike",
			severity: "low",
			target: "overview",
			evidence: { key: "2026-10-15", day: "2026-10-15", usd: 6, median: 3 },
			message: `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(y, m, d).getDay()]} cost $6.00 vs usual $3.00 a day`,
			costTokens: 5000,
			at: new Date(y, m, d).toISOString(),
		});
	});

	it("stays quiet just under 2× the median", () => {
		usual();
		day(2, 5.99);
		expect(spendSpike.run(db, PARITY_NOW)).toEqual([]);
	});

	it("needs at least $5 even at 2× a small median", () => {
		usual(14, 2);
		day(2, 4.99);
		expect(spendSpike.run(db, PARITY_NOW)).toEqual([]);
		day(1, 5);
		expect(spendSpike.run(db, PARITY_NOW).map((f) => f.evidence.key)).toEqual(["2026-10-16"]);
	});

	it("needs 14 prior active days (days with spend), not 14 calendar days", () => {
		usual(13);
		day(2, 50);
		expect(spendSpike.run(db, PARITY_NOW)).toEqual([]);
		day(40, 3); // a 14th active day, weeks earlier
		expect(spendSpike.run(db, PARITY_NOW)).toHaveLength(1);
	});

	it("leaves out the tracker's own calls", () => {
		usual();
		db.prepare(
			"INSERT INTO self_usage (feature, session_id, model, cost_usd, ts) VALUES ('summary', 's', 'claude-sonnet-4-5', 50, ?)",
		).run(localAt(2, 12));
		expect(spendSpike.run(db, PARITY_NOW)).toEqual([]);
	});

	it("only looks at the last 7 days, one finding per day", () => {
		usual(20);
		day(9, 40); // inside the usual window, too old to report
		day(3, 40);
		day(3, 1); // a second session the same day
		const keys = spendSpike.run(db, PARITY_NOW).map((f) => f.evidence.key);
		expect(keys).toEqual(["2026-10-14"]);
	});

	it("recomputes into one row per day and keeps feedback and dismissals like rules 1–4", () => {
		usual();
		day(2, 60);
		runDigestRules(db, PARITY_NOW, [spendSpike]);
		runDigestRules(db, PARITY_NOW, [spendSpike]);
		const rows = db.prepare("SELECT id, subject_key FROM findings WHERE rule = 'spend_spike'").all<{ id: number }>();
		expect(rows).toEqual([{ id: expect.any(Number), subject_key: "2026-10-15" }]);
		recordFeedback(db, rows[0].id, "helpful", PARITY_NOW);
		dismissFinding(db, rows[0].id, 30, PARITY_NOW);
		runDigestRules(db, PARITY_NOW, [spendSpike]);
		expect(db.prepare("SELECT feedback FROM findings WHERE rule = 'spend_spike'").all()).toEqual([
			{ feedback: "helpful" },
		]);
		expect(buildDigest(db, { range: "7d", now: PARITY_NOW }).items.map((i) => i.rule)).not.toContain("spend_spike");
	});
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildDigest } from "../../../src/coach/digest";
import {
	dismissFinding,
	enableRule,
	isDemoted,
	recordFeedback,
	UnknownFindingError,
} from "../../../src/coach/feedback";
import type { Finding } from "../../../src/coach/types";
import { loadConfig } from "../../../src/config";
import type { Db } from "../../../src/db/adapter";
import { upsertFindings } from "../../../src/db/queries/findings";
import { getMeta } from "../../../src/db/queries/meta";
import { getRuleFeedback } from "../../../src/db/queries/ruleFeedback";
import { seedDb } from "../../helpers/seed";
import { type TmpHome, tmpHome } from "../../helpers/tmp-home";

let h: TmpHome;
let db: Db;
beforeEach(() => {
	h = tmpHome();
	db = seedDb();
	db.prepare("INSERT INTO repos (repo_id, root_path, name) VALUES ('ra', '/a', 'a'), ('rb', '/b', 'b')").run();
});
afterEach(() => {
	db.close();
	h.cleanup();
});

const NOW = new Date("2026-10-02T12:00:00.000Z");
const at = (hours: number) => new Date(NOW.getTime() + hours * 3_600_000);

let n = 0;
/** n findings of `rule`, one per new session in `repo`; returns their ids. */
function group(rule: string, count: number, repo = "ra", cost = 100): number[] {
	const ids: number[] = [];
	for (let i = 0; i < count; i++) {
		const sid = `s${++n}`;
		db.prepare("INSERT INTO sessions (session_id, repo_id) VALUES (?, ?)").run(sid, repo);
		const f: Finding = {
			rule,
			severity: "medium",
			message: "m",
			evidence: { key: "k" },
			costTokens: cost,
			target: "session",
		};
		upsertFindings(db, sid, [rule], [f], at(-1));
		ids.push(db.prepare("SELECT id FROM findings WHERE session_id = ?").get<{ id: number }>(sid)?.id as number);
	}
	return ids;
}
const feedbackOf = (ids: number[]) =>
	ids.map(
		(id) => db.prepare("SELECT feedback FROM findings WHERE id = ?").get<{ feedback: string | null }>(id)?.feedback,
	);

describe("recordFeedback", () => {
	it("applies a vote to the whole group and counts one vote per action", () => {
		const ids = group("retry_loop", 4);
		const other = group("retry_loop", 1, "rb");
		expect(recordFeedback(db, ids[2], "not_helpful", NOW)).toEqual({ demoted: false });
		expect(feedbackOf(ids)).toEqual(["not_helpful", "not_helpful", "not_helpful", "not_helpful"]);
		expect(feedbackOf(other)).toEqual([null]);
		expect(getRuleFeedback(db, "retry_loop")).toMatchObject({ helpful: 0, notHelpful: 1, demoted: false });
	});

	it("demotes a rule after three not-helpful actions on three groups", () => {
		const a = group("retry_loop", 2, "ra");
		const b = group("retry_loop", 1, "rb");
		db.prepare("INSERT INTO sessions (session_id, repo_id) VALUES ('nr', NULL)").run();
		upsertFindings(
			db,
			"nr",
			["retry_loop"],
			[{ rule: "retry_loop", severity: "low", message: "m", evidence: { key: "k" }, costTokens: 1, target: "session" }],
			at(-1),
		);
		const c = db.prepare("SELECT id FROM findings WHERE session_id = 'nr'").get<{ id: number }>()?.id as number;
		expect(recordFeedback(db, a[0], "not_helpful", NOW).demoted).toBe(false);
		expect(recordFeedback(db, b[0], "not_helpful", NOW).demoted).toBe(false);
		expect(recordFeedback(db, c, "not_helpful", NOW).demoted).toBe(true);
		expect(isDemoted(db, "retry_loop")).toBe(true);
	});

	it("counts a repeat of the same vote on the same group as 0", () => {
		const ids = group("retry_loop", 3);
		recordFeedback(db, ids[0], "not_helpful", NOW);
		recordFeedback(db, ids[1], "not_helpful", NOW);
		expect(getRuleFeedback(db, "retry_loop")?.notHelpful).toBe(1);
	});

	it("moves one count when a group switches from helpful to not helpful", () => {
		const ids = group("retry_loop", 3);
		recordFeedback(db, ids[0], "helpful", NOW);
		expect(getRuleFeedback(db, "retry_loop")).toMatchObject({ helpful: 1, notHelpful: 0 });
		recordFeedback(db, ids[0], "not_helpful", NOW);
		expect(getRuleFeedback(db, "retry_loop")).toMatchObject({ helpful: 0, notHelpful: 1 });
		expect(feedbackOf(ids)).toEqual(["not_helpful", "not_helpful", "not_helpful"]);
	});

	it("throws UnknownFindingError for an unknown id", () => {
		expect(() => recordFeedback(db, 999, "helpful", NOW)).toThrow(UnknownFindingError);
	});
});

describe("enableRule and isDemoted", () => {
	it("re-enabling resets the counters and restores the rule's rank", () => {
		const loops = group("retry_loop", 1, "ra", 900);
		group("context_churn", 1, "ra", 10);
		db.prepare(
			"INSERT INTO rule_feedback (rule, not_helpful, demoted, updated_at) VALUES ('retry_loop', 3, 1, 't')",
		).run();
		const rank = () => buildDigest(db, { range: "7d", now: NOW, cfg: loadConfig() }).items.map((i) => i.rule);
		expect(rank()).toEqual(["context_churn", "retry_loop"]);
		enableRule(db, "retry_loop", NOW);
		expect(isDemoted(db, "retry_loop")).toBe(false);
		expect(getRuleFeedback(db, "retry_loop")).toMatchObject({ helpful: 0, notHelpful: 0, demoted: false });
		expect(rank()).toEqual(["retry_loop", "context_churn"]);
		expect(loops).toHaveLength(1);
	});

	it("isDemoted is false for a rule without feedback", () => {
		expect(isDemoted(db, "context_churn")).toBe(false);
	});
});

describe("dismissFinding", () => {
	it("dismisses the whole group for 30 days", () => {
		const ids = group("retry_loop", 3);
		const until = dismissFinding(db, ids[0], 30, NOW);
		expect(until).toBe(at(30 * 24).toISOString());
		for (const id of ids) {
			expect(db.prepare("SELECT dismissed_until AS d FROM findings WHERE id = ?").get<{ d: string }>(id)?.d).toBe(
				until,
			);
		}
	});

	it("writes meta keys for digest-rule members so a recompute keeps them dismissed", () => {
		for (const key of ["7", "8"])
			db.prepare(
				"INSERT INTO findings (rule, subject_key, severity, message, evidence, created_at) VALUES ('unused_skill', ?, 'low', 'm', '{}', ?)",
			).run(key, at(-1).toISOString());
		const id = db.prepare("SELECT id FROM findings WHERE subject_key = '7'").get<{ id: number }>()?.id as number;
		const until = dismissFinding(db, id, 30, NOW);
		expect(getMeta(db, "dismiss:unused_skill:7")).toBe(until);
		expect(getMeta(db, "dismiss:unused_skill:8")).toBe(until);
	});

	it("throws UnknownFindingError for an unknown id", () => {
		expect(() => dismissFinding(db, 999, 30, NOW)).toThrow(UnknownFindingError);
	});
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Finding } from "../../../src/coach/types";
import { type Db, openDb } from "../../../src/db/adapter";
import { migrate } from "../../../src/db/migrate";
import init001 from "../../../src/db/migrations/001_init.sql";
import inventory002 from "../../../src/db/migrations/002_inventory.sql";
import selfUsage003 from "../../../src/db/migrations/003_self_usage.sql";
import findings004 from "../../../src/db/migrations/004_findings.sql";
import removeRules005 from "../../../src/db/migrations/005_remove_rules.sql";
import { findingGroup, listFindings, upsertFindings } from "../../../src/db/queries/findings";
import { getMeta, setMeta } from "../../../src/db/queries/meta";
import { addRuleVotes, getRuleFeedback, listDemotedRules, resetRule } from "../../../src/db/queries/ruleFeedback";
import { seedDb } from "../../helpers/seed";
import { type TmpHome, tmpHome } from "../../helpers/tmp-home";

let t: TmpHome;
let db: Db;
beforeEach(() => {
	t = tmpHome();
});
afterEach(() => {
	db?.close();
	t.cleanup();
});

const NOW = new Date("2026-10-02T12:00:00.000Z");
const later = (days: number) => new Date(NOW.getTime() + days * 86_400_000);

const finding = (over: Partial<Finding> & { key?: string } = {}): Finding => {
	const { key = "npm test", ...rest } = over;
	return {
		rule: "retry_loop",
		severity: "medium",
		message: "npm test failed 3 times before passing — 12% of session tokens",
		evidence: { key, count: 3, firstTurn: 2, lastTurn: 4 },
		costTokens: 1200,
		target: "session",
		...rest,
	};
};

const rows = () =>
	db
		.prepare(
			"SELECT id, session_id, rule, subject_key, repo_id, severity, message, evidence, cost_tokens, created_at, dismissed_until, feedback FROM findings ORDER BY id",
		)
		.all<Record<string, unknown>>();

function seedSessions(): void {
	db.prepare("INSERT INTO repos (repo_id, root_path, name) VALUES ('ra', '/a', 'a'), ('rb', '/b', 'b')").run();
	db.prepare(
		"INSERT INTO sessions (session_id, repo_id, started_at) VALUES ('s1', 'ra', ?), ('s2', 'ra', ?), ('s3', 'rb', ?), ('s4', NULL, ?), ('s5', NULL, ?)",
	).run(NOW.toISOString(), NOW.toISOString(), NOW.toISOString(), NOW.toISOString(), NOW.toISOString());
}

describe("migration 004_findings", () => {
	it("upgrades a v3 DB: findings, rule_feedback, indexes and sessions.tier1_version, old rows kept", () => {
		db = openDb();
		db.transaction(() => {
			db.exec(init001);
			db.exec(inventory002);
			db.exec(selfUsage003);
			setMeta(db, "schema_version", "3");
		});
		db.prepare("INSERT INTO sessions (session_id, started_at) VALUES ('old', '2026-09-01T10:00:00Z')").run();
		migrate(db, { to: 8 });
		expect(getMeta(db, "schema_version")).toBe("8");
		const cols = (table: string) =>
			db
				.prepare(`PRAGMA table_info(${table})`)
				.all<{ name: string }>()
				.map((c) => c.name);
		expect(cols("findings")).toEqual([
			"id",
			"session_id",
			"rule",
			"subject_key",
			"repo_id",
			"severity",
			"message",
			"evidence",
			"cost_tokens",
			"created_at",
			"dismissed_until",
			"feedback",
			"agent",
		]);
		expect(cols("rule_feedback")).toEqual(["rule", "helpful", "not_helpful", "demoted", "updated_at", "agent"]);
		expect(cols("sessions")).toContain("tier1_version");
		const indexes = db
			.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'findings' ORDER BY name")
			.all<{ name: string }>()
			.map((r) => r.name);
		expect(indexes).toEqual(expect.arrayContaining(["findings_created", "findings_identity", "findings_rule_repo"]));
		expect(db.prepare("SELECT session_id, tier1_version FROM sessions").all()).toEqual([
			{ session_id: "old", tier1_version: null },
		]);
	});

	it("005 deletes the findings and rule feedback of the removed skill_unused and discarded_work rules", () => {
		db = openDb();
		db.transaction(() => {
			db.exec(init001);
			db.exec(inventory002);
			db.exec(selfUsage003);
			db.exec(findings004);
			setMeta(db, "schema_version", "4");
		});
		seedSessions();
		for (const rule of ["skill_unused", "discarded_work", "retry_loop"]) {
			upsertFindings(db, "s1", [rule], [finding({ rule })], NOW);
			addRuleVotes(db, rule, { helpful: 0, notHelpful: 1 }, NOW);
		}
		migrate(db, { to: 8 });
		expect(getMeta(db, "schema_version")).toBe("8");
		expect(db.prepare("SELECT rule FROM findings").all()).toEqual([{ rule: "retry_loop" }]);
		expect(db.prepare("SELECT rule FROM rule_feedback").all()).toEqual([{ rule: "retry_loop" }]);
	});

	it("006 dates session findings by their session's last activity; session-less rows keep theirs", () => {
		db = openDb();
		db.transaction(() => {
			for (const sql of [init001, inventory002, selfUsage003, findings004, removeRules005]) db.exec(sql);
			setMeta(db, "schema_version", "5");
		});
		db.prepare(
			"INSERT INTO sessions (session_id, started_at, ended_at) VALUES ('old', '2026-06-01T10:00:00.000Z', '2026-06-01T11:00:00.000Z'), ('nodates', NULL, NULL)",
		).run();
		const ins = db.prepare(
			"INSERT INTO findings (session_id, rule, subject_key, severity, message, evidence, created_at) VALUES (?, 'r', ?, 'low', 'm', '{}', ?)",
		);
		ins.run("old", "a", NOW.toISOString());
		ins.run("nodates", "b", NOW.toISOString());
		ins.run(null, "c", NOW.toISOString());
		migrate(db);
		expect(db.prepare("SELECT subject_key, created_at FROM findings ORDER BY subject_key").all()).toEqual([
			{ subject_key: "a", created_at: "2026-06-01T11:00:00.000Z" },
			{ subject_key: "b", created_at: NOW.toISOString() },
			{ subject_key: "c", created_at: NOW.toISOString() },
		]);
	});

	it("rejects an unknown severity or feedback value", () => {
		db = seedDb();
		const ins = (severity: string, feedback: string | null) =>
			db
				.prepare(
					"INSERT INTO findings (rule, severity, message, evidence, created_at, feedback) VALUES ('r', ?, 'm', '{}', 't', ?)",
				)
				.run(severity, feedback);
		expect(() => ins("critical", null)).toThrow(/CHECK/);
		expect(() => ins("low", "meh")).toThrow(/CHECK/);
	});

	it("deletes a session's findings with the session", () => {
		db = seedDb();
		seedSessions();
		upsertFindings(db, "s1", ["retry_loop"], [finding()], NOW);
		db.prepare("DELETE FROM sessions WHERE session_id = 's1'").run();
		expect(rows()).toEqual([]);
	});
});

describe("upsertFindings", () => {
	beforeEach(() => {
		db = seedDb();
		seedSessions();
	});

	it("inserts with subject_key from evidence.key and repo_id from the session", () => {
		upsertFindings(db, "s1", ["retry_loop"], [finding()], NOW);
		const [r] = rows();
		expect(r).toMatchObject({
			session_id: "s1",
			rule: "retry_loop",
			subject_key: "npm test",
			repo_id: "ra",
			severity: "medium",
			cost_tokens: 1200,
			created_at: NOW.toISOString(),
			dismissed_until: null,
			feedback: null,
		});
		expect(JSON.parse(r.evidence as string)).toEqual({
			key: "npm test",
			count: 3,
			firstTurn: 2,
			lastTurn: 4,
			target: "session",
		});
	});

	it("updates a rerun in place: one row, new message, created_at unchanged", () => {
		upsertFindings(db, "s1", ["retry_loop"], [finding()], NOW);
		upsertFindings(db, "s1", ["retry_loop"], [finding({ message: "changed", costTokens: 99 })], later(1));
		const all = rows();
		expect(all).toHaveLength(1);
		expect(all[0]).toMatchObject({ message: "changed", cost_tokens: 99, created_at: NOW.toISOString() });
	});

	it("dates a session finding by the session's last activity, not by when it ran (review B1)", () => {
		db.prepare("UPDATE sessions SET started_at = ?, ended_at = ? WHERE session_id = 's1'").run(
			"2026-06-01T10:00:00.000Z",
			"2026-06-01T12:00:00.000Z",
		);
		upsertFindings(db, "s1", ["retry_loop"], [finding()], NOW);
		expect(rows()[0].created_at).toBe("2026-06-01T12:00:00.000Z");
		db.prepare("UPDATE sessions SET ended_at = NULL WHERE session_id = 's1'").run();
		upsertFindings(db, "s1", ["retry_loop"], [finding()], later(1));
		expect(rows()[0].created_at).toBe("2026-06-01T10:00:00.000Z");
	});

	it("a finding's own `at` wins; a session-less finding without one is dated now on every run", () => {
		upsertFindings(
			db,
			null,
			["cache_hit_dip"],
			[finding({ rule: "cache_hit_dip", at: "2026-09-20T00:00:00.000Z" })],
			NOW,
		);
		upsertFindings(db, null, ["unused_mcp"], [finding({ rule: "unused_mcp" })], NOW);
		upsertFindings(db, null, ["unused_mcp"], [finding({ rule: "unused_mcp" })], later(3));
		expect(rows().map((r) => [r.rule, r.created_at])).toEqual([
			["cache_hit_dip", "2026-09-20T00:00:00.000Z"],
			["unused_mcp", later(3).toISOString()],
		]);
	});

	it("keeps dismissed_until and feedback across a rerun", () => {
		upsertFindings(db, "s1", ["retry_loop"], [finding(), finding({ key: "pytest" })], NOW);
		db.prepare("UPDATE findings SET dismissed_until = ? WHERE subject_key = 'npm test'").run(later(30).toISOString());
		db.prepare("UPDATE findings SET feedback = 'helpful' WHERE subject_key = 'pytest'").run();
		upsertFindings(db, "s1", ["retry_loop"], [finding(), finding({ key: "pytest" })], later(1));
		expect(rows().map((r) => [r.subject_key, r.dismissed_until, r.feedback])).toEqual([
			["npm test", later(30).toISOString(), null],
			["pytest", null, "helpful"],
		]);
	});

	it("deletes findings of the given rules that are no longer produced, unless they carry feedback", () => {
		upsertFindings(
			db,
			"s1",
			["retry_loop", "context_churn"],
			[
				finding(),
				finding({ key: "pytest" }),
				finding({ rule: "context_churn", key: "/a/x.ts", severity: "low", message: "m" }),
			],
			NOW,
		);
		db.prepare("UPDATE findings SET feedback = 'not_helpful' WHERE subject_key = 'pytest'").run();
		upsertFindings(db, "s1", ["retry_loop"], [], later(1));
		expect(rows().map((r) => [r.rule, r.subject_key])).toEqual([
			["retry_loop", "pytest"],
			["context_churn", "/a/x.ts"],
		]);
	});

	it("leaves other sessions' findings alone", () => {
		upsertFindings(db, "s1", ["retry_loop"], [finding()], NOW);
		upsertFindings(db, "s2", ["retry_loop"], [finding()], NOW);
		upsertFindings(db, "s2", ["retry_loop"], [], NOW);
		expect(rows().map((r) => r.session_id)).toEqual(["s1"]);
	});

	it("uses '' as subject_key when evidence has no key", () => {
		upsertFindings(
			db,
			"s1",
			["long_session_no_compaction"],
			[finding({ rule: "long_session_no_compaction", evidence: { wallMinutes: 130 } })],
			NOW,
		);
		expect(rows()[0].subject_key).toBe("");
	});

	it("keys session-less findings on ('', rule, subject_key) and takes repo_id from evidence.repoId", () => {
		const f = finding({ rule: "unused_skill", key: "7", target: "skills" });
		f.evidence.repoId = "rb";
		upsertFindings(db, null, ["unused_skill"], [f], NOW);
		upsertFindings(db, null, ["unused_skill"], [{ ...f, message: "again" }], later(1));
		const all = rows();
		expect(all).toHaveLength(1);
		expect(all[0]).toMatchObject({ session_id: null, repo_id: "rb", message: "again" });
		expect(() =>
			db
				.prepare(
					"INSERT INTO findings (session_id, rule, subject_key, severity, message, evidence, created_at) VALUES (NULL, 'unused_skill', '7', 'low', 'm', '{}', 't')",
				)
				.run(),
		).toThrow(/UNIQUE/);
	});

	it("rounds costTokens to a non-negative integer", () => {
		upsertFindings(
			db,
			"s1",
			["retry_loop"],
			[finding({ costTokens: 12.6 }), finding({ key: "b", costTokens: -3 })],
			NOW,
		);
		expect(rows().map((r) => r.cost_tokens)).toEqual([13, 0]);
	});
});

describe("findingGroup", () => {
	beforeEach(() => {
		db = seedDb();
		seedSessions();
	});

	const idOf = (session: string | null, rule = "retry_loop", key = "npm test") =>
		db
			.prepare("SELECT id FROM findings WHERE COALESCE(session_id, '') = ? AND rule = ? AND subject_key = ?")
			.get<{ id: number }>(session ?? "", rule, key)?.id as number;

	it("groups the same rule and repo within 30 days, excluding dismissed findings and other repos", () => {
		upsertFindings(db, "s1", ["retry_loop"], [finding()], NOW);
		upsertFindings(db, "s2", ["retry_loop"], [finding(), finding({ key: "pytest" })], later(10));
		upsertFindings(db, "s3", ["retry_loop"], [finding()], NOW); // repo rb
		upsertFindings(db, "s1", ["context_churn"], [finding({ rule: "context_churn", key: "f" })], NOW);
		db.prepare("UPDATE findings SET dismissed_until = ? WHERE session_id = 's2' AND subject_key = 'pytest'").run(
			later(40).toISOString(),
		);
		const group = findingGroup(db, idOf("s1"), later(11));
		expect(group.sort()).toEqual([idOf("s1"), idOf("s2")].sort());
	});

	it("leaves out findings more than 30 days apart", () => {
		db.prepare("UPDATE sessions SET started_at = ? WHERE session_id = 's2'").run(later(31).toISOString());
		upsertFindings(db, "s1", ["retry_loop"], [finding()], NOW);
		upsertFindings(db, "s2", ["retry_loop"], [finding()], later(31));
		expect(findingGroup(db, idOf("s1"), later(31))).toEqual([idOf("s1")]);
	});

	it("counts an expired dismissal as not dismissed", () => {
		upsertFindings(db, "s1", ["retry_loop"], [finding()], NOW);
		upsertFindings(db, "s2", ["retry_loop"], [finding()], NOW);
		db.prepare("UPDATE findings SET dismissed_until = ? WHERE session_id = 's2'").run(later(1).toISOString());
		expect(findingGroup(db, idOf("s1"), later(2))).toHaveLength(2);
	});

	it("groups NULL repos together", () => {
		upsertFindings(db, "s4", ["retry_loop"], [finding()], NOW);
		upsertFindings(db, "s5", ["retry_loop"], [finding()], NOW);
		upsertFindings(db, "s1", ["retry_loop"], [finding()], NOW);
		expect(findingGroup(db, idOf("s4"), NOW).sort()).toEqual([idOf("s4"), idOf("s5")].sort());
	});

	it("returns [] for an unknown id", () => {
		expect(findingGroup(db, 999, NOW)).toEqual([]);
	});
});

describe("listFindings", () => {
	beforeEach(() => {
		db = seedDb();
		seedSessions();
		db.prepare("UPDATE sessions SET started_at = ? WHERE session_id = 's1'").run(later(-10).toISOString());
		upsertFindings(db, "s1", ["retry_loop"], [finding()], later(-10));
		upsertFindings(db, "s3", ["retry_loop"], [finding()], NOW);
		db.prepare(
			"INSERT INTO rule_feedback (rule, helpful, not_helpful, demoted, updated_at) VALUES ('retry_loop', 0, 3, 1, ?)",
		).run(NOW.toISOString());
	});

	it("returns FindingRow objects in range, newest first", () => {
		const list = listFindings(db, { range: "7d", now: later(0.1) });
		expect(list).toHaveLength(1);
		expect(list[0]).toEqual({
			id: expect.any(Number),
			sessionId: "s3",
			rule: "retry_loop",
			label: "retry loop",
			severity: "medium",
			message: finding().message,
			evidence: { key: "npm test", count: 3, firstTurn: 2, lastTurn: 4, target: "session" },
			costTokens: 1200,
			createdAt: NOW.toISOString(),
			dismissedUntil: null,
			feedback: null,
			demoted: true,
			repoId: "rb",
		});
		expect(listFindings(db, { range: "30d", now: later(0.1) }).map((f) => f.sessionId)).toEqual(["s3", "s1"]);
	});

	it("filters by repo and by session", () => {
		expect(listFindings(db, { range: "30d", repo: "ra", now: later(0.1) }).map((f) => f.sessionId)).toEqual(["s1"]);
		expect(listFindings(db, { session: "s1", now: later(0.1) }).map((f) => f.sessionId)).toEqual(["s1"]);
	});
});

describe("rule_feedback queries", () => {
	beforeEach(() => {
		db = seedDb();
	});

	it("counts votes, demotes at three not-helpful, never goes below zero, and resets on re-enable", () => {
		expect(getRuleFeedback(db, "retry_loop")).toBeNull();
		addRuleVotes(db, "retry_loop", { helpful: 1, notHelpful: 0 }, NOW);
		addRuleVotes(db, "retry_loop", { helpful: -1, notHelpful: 1 }, NOW);
		addRuleVotes(db, "retry_loop", { helpful: -1, notHelpful: 1 }, NOW);
		expect(getRuleFeedback(db, "retry_loop")).toMatchObject({ helpful: 0, notHelpful: 2, demoted: false });
		const r = addRuleVotes(db, "retry_loop", { helpful: 0, notHelpful: 1 }, later(1));
		expect(r).toMatchObject({ notHelpful: 3, demoted: true });
		expect(listDemotedRules(db)).toEqual([{ rule: "retry_loop", notHelpful: 3, demotedAt: later(1).toISOString() }]);
		resetRule(db, "retry_loop", later(2));
		expect(getRuleFeedback(db, "retry_loop")).toMatchObject({ helpful: 0, notHelpful: 0, demoted: false });
		expect(listDemotedRules(db)).toEqual([]);
	});
});

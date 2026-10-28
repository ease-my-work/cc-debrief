import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../../../src/db/adapter";
import { migrate } from "../../../src/db/migrate";
import init001 from "../../../src/db/migrations/001_init.sql";
import inventory002 from "../../../src/db/migrations/002_inventory.sql";
import selfUsage003 from "../../../src/db/migrations/003_self_usage.sql";
import findings004 from "../../../src/db/migrations/004_findings.sql";
import removeRules005 from "../../../src/db/migrations/005_remove_rules.sql";
import findingDates006 from "../../../src/db/migrations/006_finding_dates.sql";
import reviews007 from "../../../src/db/migrations/007_reviews.sql";
import { getMeta, setMeta } from "../../../src/db/queries/meta";
import {
	findOverlappingPattern,
	getPattern,
	listPatterns,
	type PatternInput,
	setPatternError,
	setPatternStatus,
	upsertPattern,
} from "../../../src/db/queries/patterns";
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

const NOW = new Date("2026-10-10T12:00:00.000Z");
const input = (over: Partial<PatternInput> = {}): PatternInput => ({
	repoId: "ra",
	label: "fix trivy findings",
	labelNorm: "fix trivy find",
	kind: "repo_skill",
	sessionIds: ["s1", "s2", "s3"],
	tokensTotal: 120_000,
	fingerprint: "Bash:trivy → Read:Dockerfile → Edit:Dockerfile",
	firstSeen: "2026-10-01T00:00:00.000Z",
	lastSeen: "2026-10-09T00:00:00.000Z",
	...over,
});

describe("migration 008_patterns", () => {
	it("upgrades a v7 DB to v8 with the patterns table and its indexes", () => {
		db = openDb();
		db.transaction(() => {
			for (const sql of [init001, inventory002, selfUsage003, findings004, removeRules005, findingDates006, reviews007])
				db.exec(sql);
			setMeta(db, "schema_version", "7");
		});
		migrate(db, { to: 8 });
		expect(getMeta(db, "schema_version")).toBe("8");
		const cols = db
			.prepare("PRAGMA table_info(patterns)")
			.all<{ name: string }>()
			.map((c) => c.name);
		expect(cols).toEqual([
			"id",
			"repo_id",
			"label",
			"label_norm",
			"kind",
			"session_ids",
			"tokens_total",
			"fingerprint",
			"meta",
			"first_seen",
			"last_seen",
			"status",
			"draft_path",
			"inventory_id",
			"installed_at",
			"dismissed_at",
			"agent",
		]);
		const indexes = db
			.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'patterns'")
			.all<{ name: string }>()
			.map((r) => r.name);
		expect(indexes).toEqual(expect.arrayContaining(["patterns_identity", "patterns_repo_status"]));
	});

	it("rejects an unknown kind or status", () => {
		db = seedDb();
		const ins = (kind: string, status: string) =>
			db
				.prepare(
					"INSERT INTO patterns (label, label_norm, kind, status, first_seen, last_seen) VALUES ('l', 'l', ?, ?, 't', 't')",
				)
				.run(kind, status);
		expect(() => ins("skill", "candidate")).toThrow(/CHECK/);
		expect(() => ins("repo_skill", "new")).toThrow(/CHECK/);
	});
});

describe("pattern queries", () => {
	beforeEach(() => {
		db = seedDb();
	});

	it("identity is (repo, kind, normalized label); two NULL repos collide", () => {
		const a = upsertPattern(db, input({ repoId: null, kind: "user_skill" }));
		const b = upsertPattern(db, input({ repoId: null, kind: "user_skill", sessionIds: ["s1", "s2", "s3", "s4"] }));
		expect(a.created).toBe(true);
		expect(b).toEqual({ id: a.id, created: false, updated: true });
		expect(() =>
			db
				.prepare(
					"INSERT INTO patterns (repo_id, label, label_norm, kind, first_seen, last_seen) VALUES (NULL, 'x', 'fix trivy find', 'user_skill', 't', 't')",
				)
				.run(),
		).toThrow(/UNIQUE/);
		// another kind or repo is another pattern
		expect(upsertPattern(db, input({ repoId: null, kind: "repo_skill" })).created).toBe(true);
		expect(upsertPattern(db, input({ repoId: "rb", kind: "user_skill" })).created).toBe(true);
	});

	it("an unchanged rerun updates nothing; detection never changes the status", () => {
		const { id } = upsertPattern(db, input());
		expect(upsertPattern(db, input())).toEqual({ id, created: false, updated: false });
		setPatternStatus(db, id, "drafted", { draftPath: "/d/x/SKILL.md" });
		upsertPattern(db, input({ sessionIds: ["s1", "s2", "s3", "s4"], tokensTotal: 160_000 }));
		expect(getPattern(db, id)).toMatchObject({
			status: "drafted",
			draftPath: "/d/x/SKILL.md",
			sessionIds: ["s1", "s2", "s3", "s4"],
			tokensTotal: 160_000,
		});
	});

	it("keeps the last draft error across detection reruns", () => {
		const { id } = upsertPattern(db, input({ meta: { correctionCount: 3 } }));
		setPatternError(db, id, "exit 1: boom");
		upsertPattern(db, input({ meta: { correctionCount: 4 } }));
		expect(getPattern(db, id)?.meta).toEqual({ correctionCount: 4, error: "exit 1: boom" });
	});

	it("overlap lookup: ≥ 50% of the existing row's sessions is a hit, 49% a miss", () => {
		const ten = Array.from({ length: 10 }, (_, i) => `s${i}`);
		upsertPattern(db, input({ sessionIds: ten }));
		expect(findOverlappingPattern(db, "ra", "repo_skill", ["s0", "s1", "s2", "s3", "s4", "x"])?.sessionIds).toEqual(
			ten,
		);
		const hundred = Array.from({ length: 100 }, (_, i) => `t${i}`);
		upsertPattern(db, input({ labelNorm: "other", label: "other", sessionIds: hundred }));
		expect(findOverlappingPattern(db, "ra", "repo_skill", hundred.slice(0, 49))).toBeNull();
		expect(findOverlappingPattern(db, "ra", "repo_skill", hundred.slice(0, 50))?.labelNorm).toBe("other");
		expect(findOverlappingPattern(db, "ra", "test_gap", ten)).toBeNull(); // another kind
		expect(findOverlappingPattern(db, "rb", "repo_skill", ten)).toBeNull(); // another repo
	});

	it("status changes set installed_at, dismissed_at and the inventory link", () => {
		const { id } = upsertPattern(db, input());
		setPatternStatus(db, id, "dismissed", { now: NOW });
		expect(getPattern(db, id)).toMatchObject({ status: "dismissed", dismissedAt: NOW.toISOString() });
		setPatternStatus(db, id, "candidate", { now: NOW });
		expect(getPattern(db, id)).toMatchObject({ status: "candidate", dismissedAt: null });
		db.prepare(
			"INSERT INTO inventory (id, scope, repo_id, kind, name, path, first_seen, last_seen) VALUES (7, 'repo', 'ra', 'skill', 'trivy', '/r', 't', 't')",
		).run();
		setPatternStatus(db, id, "installed", { inventoryId: 7, now: NOW });
		expect(getPattern(db, id)).toMatchObject({ status: "installed", installedAt: NOW.toISOString(), inventoryId: 7 });
	});

	it("deleting the inventory row nulls inventory_id", () => {
		const { id } = upsertPattern(db, input());
		db.prepare(
			"INSERT INTO inventory (id, scope, repo_id, kind, name, path, first_seen, last_seen) VALUES (7, 'repo', 'ra', 'skill', 'trivy', '/r', 't', 't')",
		).run();
		setPatternStatus(db, id, "installed", { inventoryId: 7 });
		db.prepare("DELETE FROM inventory WHERE id = 7").run();
		expect(getPattern(db, id)?.inventoryId).toBeNull();
	});

	it("listPatterns returns PatternRow items by tokens, filtered by repo and status", () => {
		upsertPattern(db, input({ tokensTotal: 10 }));
		upsertPattern(db, input({ labelNorm: "b", label: "b", tokensTotal: 30, meta: { readFiles: ["a.md", "b.ts"] } }));
		upsertPattern(db, input({ repoId: "rb", labelNorm: "c", label: "c", tokensTotal: 20 }));
		const rows = listPatterns(db, { repo: "ra" });
		expect(rows.map((r) => r.label)).toEqual(["b", "fix trivy findings"]);
		expect(rows[0]).toMatchObject({ sessionCount: 3, readFiles: ["a.md", "b.ts"], correctionCount: null, error: null });
		expect(listPatterns(db).map((r) => r.label)).toEqual(["b", "c", "fix trivy findings"]);
		expect(listPatterns(db, { status: "drafted" })).toEqual([]);
	});
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../../src/db/adapter";
import { setMeta } from "../../../src/db/queries/meta";
import { getPattern, setPatternStatus, upsertPattern } from "../../../src/db/queries/patterns";
import { adoptionStats, checkInstalledPatterns } from "../../../src/patterns/adoption";
import { detectPatterns } from "../../../src/patterns/detect";
import { daysAgo, PATTERN_NOW, seedPatternSession } from "../../helpers/pattern-seed";
import { seedDb } from "../../helpers/seed";
import { type TmpHome, tmpHome } from "../../helpers/tmp-home";

let h: TmpHome;
let db: Db;
beforeEach(() => {
	h = tmpHome();
	db = seedDb();
});
afterEach(() => {
	db.close();
	h.cleanup();
});

const NOW = PATTERN_NOW;
const INSTALLED = new Date(NOW.getTime() - 15 * 86_400_000);

/** An installed repo skill `trivy-fix` (inventory 7) for sessions before (b*) and after (a*) its install 15 days ago. */
function installed(before: [string, number, number][], after: [string, number, number][]): number {
	for (const [id, tokens, minutes] of before)
		seedPatternSession(db, id, { startedAt: daysAgo(20 + before.length), tokens, durationMin: minutes });
	for (const [i, [id, tokens, minutes]] of after.entries())
		seedPatternSession(db, id, { startedAt: daysAgo(10 - i), tokens, durationMin: minutes });
	db.prepare(
		"INSERT INTO inventory (id, scope, repo_id, kind, name, path, first_seen, last_seen) VALUES (7, 'repo', 'ra', 'skill', 'trivy-fix', '/r/.claude/skills/trivy-fix', ?, ?)",
	).run(INSTALLED.toISOString(), NOW.toISOString());
	const { id } = upsertPattern(db, {
		repoId: "ra",
		label: "fix trivy findings",
		labelNorm: "fix trivy find",
		kind: "repo_skill",
		sessionIds: [...before, ...after].map(([s]) => s),
		tokensTotal: 1,
		fingerprint: null,
		firstSeen: daysAgo(30),
		lastSeen: daysAgo(1),
	});
	setPatternStatus(db, id, "installed", { inventoryId: 7, now: INSTALLED });
	return id;
}
const invoke = (sessionId: string, skill = "trivy-fix") =>
	db
		.prepare(
			"INSERT INTO tool_calls (session_id, tool_use_id, tool_name, skill_name, started_at, ok) VALUES (?, ?, 'Skill', ?, ?, 1)",
		)
		.run(sessionId, `${sessionId}-skill`, skill, daysAgo(1));
const notTriggering = () =>
	db
		.prepare(
			"SELECT subject_key, message, json_extract(evidence, '$.target') AS target FROM findings WHERE rule = 'skill_not_triggering'",
		)
		.all<{ subject_key: string; message: string }>();

describe("adoptionStats", () => {
	it("counts invocations only in sessions started after install", () => {
		const id = installed([["b1", 82_000, 34]], [["a1", 51_000, 19]]);
		invoke("b1");
		invoke("a1");
		db.prepare("UPDATE tool_calls SET tool_use_id = ? WHERE session_id = ?").run("a1-skill-1", "a1");
		invoke("a1", "other");
		expect(adoptionStats(db, id, NOW)).toMatchObject({
			invoked: 1,
			installedDays: 15,
			skillName: "trivy-fix",
			removed: false,
		});
	});

	it("medians before and after; after only with ≥ 2 post-install sessions", () => {
		const id = installed(
			[
				["b1", 82_000, 34],
				["b2", 90_000, 40],
				["b3", 70_000, 30],
			],
			[["a1", 51_000, 19]],
		);
		const one = adoptionStats(db, id, NOW);
		expect(one.before).toEqual({ medianTokens: 82_000, medianDurationSec: 34 * 60, n: 3 });
		expect(one.after).toBeNull();
		seedPatternSession(db, "a2", { startedAt: daysAgo(2), tokens: 41_000, durationMin: 15 });
		const p = getPattern(db, id);
		upsertPattern(db, { ...(p as NonNullable<typeof p>), id, sessionIds: [...(p?.sessionIds ?? []), "a2"] });
		expect(adoptionStats(db, id, NOW).after).toEqual({ medianTokens: 46_000, medianDurationSec: 17 * 60, n: 2 });
	});

	it("a skill the latest scan no longer found is removed; the status stays installed", () => {
		const id = installed([["b1", 1000, 10]], []);
		setMeta(db, "last_scan_repo:ra", new Date(NOW.getTime() + 1000).toISOString());
		expect(adoptionStats(db, id, NOW).removed).toBe(true);
		expect(getPattern(db, id)?.status).toBe("installed");
	});

	it("a candidate has no adoption numbers", () => {
		const { id } = upsertPattern(db, {
			repoId: "ra",
			label: "x",
			labelNorm: "x",
			kind: "repo_skill",
			sessionIds: [],
			tokensTotal: 0,
			fingerprint: null,
			firstSeen: daysAgo(1),
			lastSeen: daysAgo(1),
		});
		expect(adoptionStats(db, id, NOW)).toMatchObject({ invoked: null, before: null, after: null, installedDays: null });
	});
});

describe("checkInstalledPatterns", () => {
	it("15 days, 0 invocations, 1 new matching session: a skill_not_triggering finding", () => {
		const id = installed([["b1", 1000, 10]], [["a1", 40_000, 10]]);
		expect(checkInstalledPatterns(db, NOW)).toBe(1);
		expect(notTriggering()).toEqual([
			{
				subject_key: `pattern:${id}`,
				message:
					"`trivy-fix` skill not triggering — description too narrow: 0 invocations in 15 days while the task came back 1 time",
				target: "skills",
			},
		]);
	});

	it("13 days: none; no matching session since install: none", () => {
		installed([["b1", 1000, 10]], [["a1", 1000, 10]]);
		expect(checkInstalledPatterns(db, new Date(INSTALLED.getTime() + 13 * 86_400_000))).toBe(0);
		db.prepare("DELETE FROM patterns").run();
		db.prepare("DELETE FROM inventory").run();
		installed([["c1", 1000, 10]], []);
		expect(checkInstalledPatterns(db, NOW)).toBe(0);
	});

	it("invoked once: the finding goes", () => {
		installed([["b1", 1000, 10]], [["a1", 1000, 10]]);
		checkInstalledPatterns(db, NOW);
		expect(notTriggering()).toHaveLength(1);
		invoke("a1");
		checkInstalledPatterns(db, NOW);
		expect(notTriggering()).toHaveLength(0);
	});
});

describe("detection keeps an installed row's earlier sessions", () => {
	it("pre-install sessions past the 30-day window stay in session_ids for the before median", () => {
		for (const id of ["old1", "old2", "old3"])
			seedPatternSession(db, id, { label: "fix trivy findings", startedAt: daysAgo(25) });
		detectPatterns(db, "ra", NOW);
		const id = (db.prepare("SELECT id FROM patterns").get() as { id: number }).id;
		setPatternStatus(db, id, "installed", { now: new Date(NOW.getTime() - 20 * 86_400_000) });
		for (const s of ["n1", "n2", "n3"])
			seedPatternSession(db, s, { label: "fix trivy findings", startedAt: daysAgo(2) });
		detectPatterns(db, "ra", new Date(NOW.getTime() + 10 * 86_400_000)); // old1-3 are now 35 days old
		expect(getPattern(db, id)?.sessionIds).toEqual(["old1", "old2", "old3", "n1", "n2", "n3"]);
	});
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildDigest } from "../../../src/coach/digest";
import type { Finding, Severity } from "../../../src/coach/types";
import { loadConfig } from "../../../src/config";
import type { Db } from "../../../src/db/adapter";
import { upsertFindings } from "../../../src/db/queries/findings";
import { setMeta } from "../../../src/db/queries/meta";
import { seedDb } from "../../helpers/seed";
import { type TmpHome, tmpHome } from "../../helpers/tmp-home";

let h: TmpHome;
let db: Db;
beforeEach(() => {
	h = tmpHome();
	db = seedDb();
	db.prepare(
		"INSERT INTO repos (repo_id, root_path, name) VALUES ('github.com/me/a', '/a', 'a'), ('rb', '/b', 'b')",
	).run();
});
afterEach(() => {
	db.close();
	h.cleanup();
});

/** Fri 2 Oct 2026 12:00 local. */
const NOW = new Date(2026, 9, 2, 12, 0, 0);
const hoursAgo = (n: number) => new Date(NOW.getTime() - n * 3_600_000);
const A = "github.com/me/a";

let n = 0;
/** One finding in a new session of `repo`, created `ago` hours before NOW. */
function sessionFinding(o: {
	rule: string;
	repo?: string | null;
	cost: number;
	severity?: Severity;
	ago?: number;
	key?: string;
	message?: string;
}): { sessionId: string; id: number } {
	const sessionId = `s${++n}`;
	db.prepare("INSERT INTO sessions (session_id, repo_id, started_at) VALUES (?, ?, ?)").run(
		sessionId,
		o.repo === undefined ? A : o.repo,
		hoursAgo(o.ago ?? 1).toISOString(),
	);
	const f: Finding = {
		rule: o.rule,
		severity: o.severity ?? "medium",
		message: o.message ?? `${o.rule} in ${sessionId}`,
		evidence: { key: o.key ?? "k", count: 3 },
		costTokens: o.cost,
		target: "session",
	};
	upsertFindings(db, sessionId, [o.rule], [f], hoursAgo(o.ago ?? 1));
	const id = db.prepare("SELECT id FROM findings WHERE session_id = ?").get<{ id: number }>(sessionId)?.id as number;
	return { sessionId, id };
}

const digest = (o: { range?: "today" | "7d" | "30d"; repo?: string } = {}) =>
	buildDigest(db, { range: o.range ?? "7d", repo: o.repo, now: NOW, cfg: loadConfig() });

describe("buildDigest", () => {
	it("groups by rule and repo, sums cost and ranks by it", () => {
		const loopsA = [100, 200, 300, 400].map((cost) => sessionFinding({ rule: "retry_loop", cost }));
		sessionFinding({ rule: "retry_loop", repo: "rb", cost: 150 });
		sessionFinding({ rule: "context_churn", cost: 250 });
		sessionFinding({ rule: "context_churn", cost: 250 });
		const { items } = digest();
		expect(items.map((i) => [i.rule, i.repoId, i.costTokens, i.sessionCount])).toEqual([
			["retry_loop", A, 1000, 4],
			["context_churn", A, 500, 2],
			["retry_loop", "rb", 150, 1],
		]);
		expect(items[0]).toEqual({
			id: loopsA[3].id, // the costliest finding represents the group
			rule: "retry_loop",
			severity: "medium",
			message: "Retry loop in 4 sessions in `a`",
			costTokens: 1000,
			sessionCount: 4,
			repoId: A,
			target: "session",
			href: `/sessions/${loopsA[3].sessionId}`,
			demoted: false,
			collapsed: false,
			feedback: null,
			action: null,
		});
		expect(items[2].message).toBe("retry_loop in s5"); // a single finding keeps its own message
	});

	it("never puts a zero-cost item in the top three, whatever its severity", () => {
		sessionFinding({ rule: "permission_friction", cost: 0, severity: "high" });
		sessionFinding({ rule: "retry_loop", cost: 10, severity: "low" });
		expect(digest().items.map((i) => i.rule)).toEqual(["retry_loop"]);
	});

	it("returns at most three items", () => {
		for (const rule of ["retry_loop", "context_churn", "long_session_no_compaction", "mcp_bypassed"]) {
			sessionFinding({ rule, cost: 100 });
		}
		expect(digest().items).toHaveLength(3);
	});

	it("breaks cost ties by severity, then the most recent finding", () => {
		sessionFinding({ rule: "retry_loop", cost: 100, severity: "low", ago: 1 });
		sessionFinding({ rule: "context_churn", cost: 100, severity: "high", ago: 5 });
		sessionFinding({ rule: "mcp_bypassed", cost: 100, severity: "low", ago: 2 });
		expect(digest().items.map((i) => i.rule)).toEqual(["context_churn", "retry_loop", "mcp_bypassed"]);
	});

	it("ranks a demoted rule's items after every non-demoted item but still shows them", () => {
		sessionFinding({ rule: "retry_loop", cost: 900 });
		sessionFinding({ rule: "context_churn", cost: 10 });
		db.prepare(
			"INSERT INTO rule_feedback (rule, not_helpful, demoted, updated_at) VALUES ('retry_loop', 3, 1, 't')",
		).run();
		const { items } = digest();
		expect(items.map((i) => [i.rule, i.demoted])).toEqual([
			["context_churn", false],
			["retry_loop", true],
		]);
	});

	it("covers only today's findings for range today, while the footer stays on 7 days", () => {
		sessionFinding({ rule: "retry_loop", cost: 10, ago: 1 });
		sessionFinding({ rule: "context_churn", cost: 10, ago: 30 });
		const d = digest({ range: "today" });
		expect(d.items.map((i) => i.rule)).toEqual(["retry_loop"]);
		expect(d.footer.reviewsThisWeek).toBe(0);
		expect(d.footer.reviewsEnabled).toBe(false);
		expect(d.footer.selfUsage).toEqual(expect.objectContaining({ summaries: 0 }));
	});

	it("filters by repo", () => {
		sessionFinding({ rule: "retry_loop", cost: 10 });
		sessionFinding({ rule: "retry_loop", repo: "rb", cost: 10 });
		expect(digest({ repo: "rb" }).items.map((i) => i.repoId)).toEqual(["rb"]);
	});

	it("leaves out dismissed findings and counts them in the footer", () => {
		const { id } = sessionFinding({ rule: "retry_loop", cost: 10 });
		sessionFinding({ rule: "context_churn", cost: 5 });
		db.prepare("UPDATE findings SET dismissed_until = ? WHERE id = ?").run(hoursAgo(-24 * 30).toISOString(), id);
		const d = digest();
		expect(d.items.map((i) => i.rule)).toEqual(["context_churn"]);
		expect(d.footer.dismissed).toBe(1);
	});

	it("leaves out a session-less finding whose meta dismissal is in the future", () => {
		upsertFindings(
			db,
			null,
			["unused_skill"],
			[
				{
					rule: "unused_skill",
					severity: "low",
					message: "m",
					evidence: { key: "7" },
					costTokens: 50,
					target: "skills",
				},
			],
			hoursAgo(1),
		);
		setMeta(db, "dismiss:unused_skill:7", hoursAgo(-48).toISOString());
		expect(digest().items).toEqual([]);
	});

	it("links each target to the view that resolves it", () => {
		const row = (rule: string, target: Finding["target"], key: string, repoId: string | null = null, extra = {}) =>
			upsertFindings(
				db,
				null,
				[rule],
				[{ rule, severity: "low", message: rule, evidence: { key, repoId, ...extra }, costTokens: 10, target }],
				hoursAgo(1),
			);
		row("unused_skill", "skills", "1");
		row("unused_mcp", "skills", "2");
		row("tool_failure_hotspot", "repos", "rb|Bash: pytest", "rb");
		row("cache_hit_dip", "overview", "2026-10-01");
		row("model_mix", "session", "claude-opus-4-1");
		const s = sessionFinding({ rule: "context_churn", cost: 10 });
		const all = buildDigest(db, { range: "7d", now: NOW, cfg: loadConfig(), limit: 10 }).items;
		expect(Object.fromEntries(all.map((i) => [i.rule, i.href]))).toEqual({
			unused_skill: "/skills?tab=skills&unused=1",
			unused_mcp: "/skills?tab=mcp&unused=1",
			tool_failure_hotspot: "/repos/rb",
			cache_hit_dip: "/sessions?range=7d",
			model_mix: "/sessions?type=exploration",
			context_churn: `/sessions/${s.sessionId}`,
		});
		const hotspot = all.find((i) => i.rule === "tool_failure_hotspot");
		expect(hotspot?.repoId).toBe("rb");
	});

	it("names a session-less group by label and count", () => {
		for (const key of ["1", "2", "3"])
			upsertFindings(
				db,
				null,
				["unused_skill"],
				[{ rule: "unused_skill", severity: "low", message: key, evidence: { key }, costTokens: 10, target: "skills" }],
				hoursAgo(1),
			);
		// upsertFindings replaces per rule, so insert the others directly
		expect(digest().items[0]).toMatchObject({ message: "3", sessionCount: 0 });
		db.prepare(
			"INSERT INTO findings (rule, subject_key, severity, message, evidence, cost_tokens, created_at) VALUES ('unused_skill', '4', 'low', '4', '{}', 10, ?), ('unused_skill', '5', 'low', '5', '{}', 10, ?)",
		).run(hoursAgo(1).toISOString(), hoursAgo(1).toISOString());
		expect(digest().items[0]).toMatchObject({ message: "Unused skill ×3", costTokens: 30 });
	});

	it("encodes a repo id with slashes in a repos link", () => {
		upsertFindings(
			db,
			null,
			["tool_failure_hotspot"],
			[
				{
					rule: "tool_failure_hotspot",
					severity: "low",
					message: "m",
					evidence: { key: "x", repoId: A },
					costTokens: 10,
					target: "repos",
				},
			],
			hoursAgo(1),
		);
		expect(digest().items[0].href).toBe(`/repos/${encodeURIComponent(A)}`);
	});
});

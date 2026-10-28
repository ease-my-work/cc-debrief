import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DIGEST_RULES, type DigestRule, runDigestRules } from "../../../src/coach/digest";
import { cacheHitDip } from "../../../src/coach/digest-rules/cache-hit-dip";
import { modelMix } from "../../../src/coach/digest-rules/model-mix";
import { toolFailureHotspot } from "../../../src/coach/digest-rules/tool-failure-hotspot";
import { unusedMcp } from "../../../src/coach/digest-rules/unused-mcp";
import { unusedSkill } from "../../../src/coach/digest-rules/unused-skill";
import { recordFeedback } from "../../../src/coach/feedback";
import type { Db } from "../../../src/db/adapter";
import { setMeta } from "../../../src/db/queries/meta";
import { encodePayload } from "../../../src/ingest/line";
import { seedDb, storeLines } from "../../helpers/seed";
import { type TmpHome, tmpHome } from "../../helpers/tmp-home";

let h: TmpHome;
let db: Db;
beforeEach(() => {
	h = tmpHome();
	db = seedDb();
	db.prepare("INSERT INTO repos (repo_id, root_path, name) VALUES ('ra', '/a', 'app'), ('rb', '/b', 'api')").run();
});
afterEach(() => {
	db.close();
	h.cleanup();
});

/** Fri 2 Oct 2026 12:00 local. */
const NOW = new Date(2026, 9, 2, 12, 0, 0);
/** Local time `days` before NOW at hour h. */
const daysAgo = (days: number, hour = 10, min = 0) => new Date(2026, 9, 2 - days, hour, min, 0).toISOString();

let n = 0;
function session(o: {
	id?: string;
	at?: string;
	minutes?: number;
	repo?: string | null;
	type?: string | null;
	usage?: {
		input?: number;
		cacheRead?: number;
		cacheCreation?: number;
		output?: number;
		model?: string;
		cost?: number;
	}[];
}): string {
	const id = o.id ?? `s${++n}`;
	const start = o.at ?? daysAgo(1);
	const end = new Date(Date.parse(start) + (o.minutes ?? 30) * 60_000).toISOString();
	db.prepare(
		"INSERT INTO sessions (session_id, started_at, ended_at, repo_id, session_type) VALUES (?, ?, ?, ?, ?)",
	).run(id, start, end, o.repo === undefined ? "ra" : o.repo, o.type ?? null);
	for (const u of o.usage ?? []) {
		db.prepare(
			`INSERT INTO usage (session_id, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, cost_usd, ts)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			id,
			u.model ?? "claude-sonnet-4-5",
			u.input ?? 0,
			u.output ?? 0,
			u.cacheCreation ?? 0,
			u.cacheRead ?? 0,
			u.cost ?? null,
			start,
		);
	}
	return id;
}

function item(o: {
	kind: "skill" | "mcp";
	name: string;
	scope?: string;
	repo?: string | null;
	desc?: string | null;
	meta?: object;
}) {
	return Number(
		db
			.prepare(
				`INSERT INTO inventory (scope, repo_id, kind, name, path, description, first_seen, last_seen, meta)
				 VALUES (?, ?, ?, ?, '/p', ?, ?, ?, ?)`,
			)
			.run(
				o.scope ?? "user",
				o.repo ?? null,
				o.kind,
				o.name,
				o.desc ?? null,
				daysAgo(60),
				NOW.toISOString(),
				JSON.stringify(o.meta ?? {}),
			).lastInsertRowid,
	);
}
const use = (itemId: number, sessionId: string, invoked = 0) =>
	db
		.prepare("INSERT INTO inventory_usage (inventory_id, session_id, loaded, invoked) VALUES (?, ?, 1, ?)")
		.run(itemId, sessionId, invoked);

const run = (r: DigestRule) => r.run(db, NOW);

describe("unused_skill", () => {
	it("fires for a skill loaded in 90% of sessions and never invoked", () => {
		const pdf = item({ kind: "skill", name: "pdf", desc: "x".repeat(1920) }); // 480 tokens
		const ids = Array.from({ length: 10 }, (_, i) => session({ at: daysAgo(i + 1) }));
		for (const id of ids.slice(0, 9)) use(pdf, id);
		expect(run(unusedSkill)).toEqual([
			{
				rule: "unused_skill",
				severity: "low",
				message: "`pdf` loaded in 9 of 10 sessions, never invoked · ~480 tokens per session",
				evidence: { key: String(pdf), skill: "pdf", loaded: 9, sessions: 10, tokensPerSession: 480, repoId: null },
				costTokens: 480 * 9,
				target: "skills",
			},
		]);
	});

	it("does not fire at 70% or when invoked once", () => {
		const a = item({ kind: "skill", name: "a", desc: "d" });
		const b = item({ kind: "skill", name: "b", desc: "d" });
		const ids = Array.from({ length: 10 }, (_, i) => session({ at: daysAgo(i + 1) }));
		for (const id of ids.slice(0, 7)) use(a, id);
		for (const [i, id] of ids.entries()) use(b, id, i === 0 ? 1 : 0);
		expect(run(unusedSkill)).toEqual([]);
	});

	it("counts only the repo's sessions for a repo skill, and ignores sessions older than 30 days", () => {
		const r = item({ kind: "skill", name: "deploy", scope: "repo", repo: "rb", desc: "dddd" });
		const inRepo = [session({ repo: "rb" }), session({ repo: "rb" })];
		for (let i = 0; i < 5; i++) session({ repo: "ra" });
		const old = session({ repo: "rb", at: daysAgo(40) });
		for (const id of [...inRepo, old]) use(r, id);
		const [f] = run(unusedSkill);
		expect(f.message).toBe("`deploy` loaded in 2 of 2 sessions, never invoked · ~1 tokens per session");
		expect(f.evidence.repoId).toBe("rb");
	});
});

describe("unused_mcp", () => {
	const listing = (sessionId: string, names: string[], removed: string[] = []) =>
		storeLines(db, sessionId, [
			{
				type: "attachment",
				uuid: `att-${sessionId}-${names.length}`,
				timestamp: daysAgo(1),
				attachment: { type: "deferred_tools_delta", addedNames: names, removedNames: removed },
			},
		]);

	it("counts tool schemas from the latest loaded session's listings, else estimates 10", () => {
		const neo = item({ kind: "mcp", name: "neo4j" });
		const pg = item({ kind: "mcp", name: "pg" });
		const a = session({ at: daysAgo(2) });
		const b = session({ at: daysAgo(1) });
		for (const id of [a, b]) {
			use(neo, id);
			use(pg, id);
		}
		const tools = (server: string, k: number) => Array.from({ length: k }, (_, i) => `mcp__${server}__t${i}`);
		listing(b, [...tools("neo4j", 13), "Read", "mcp__other__x"], ["mcp__neo4j__t12"]);
		const findings = run(unusedMcp);
		expect(findings).toEqual([
			{
				rule: "unused_mcp",
				severity: "low",
				message: "MCP server `neo4j` configured, 0 calls in 30 days · 12 tool schemas",
				evidence: {
					key: String(neo),
					server: "neo4j",
					calls: 0,
					schemas: 12,
					estimated: false,
					sessions: 2,
					repoId: null,
				},
				costTokens: 12 * 150 * 2,
				target: "skills",
			},
			{
				rule: "unused_mcp",
				severity: "low",
				message: "MCP server `pg` configured, 0 calls in 30 days · ~10 tool schemas (estimated)",
				evidence: { key: String(pg), server: "pg", calls: 0, schemas: 10, estimated: true, sessions: 2, repoId: null },
				costTokens: 10 * 150 * 2,
				target: "skills",
			},
		]);
	});

	it("does not fire with one call in 30 days; a plugin server matches its own source only", () => {
		const gh = item({ kind: "mcp", name: "github" });
		const plug = item({ kind: "mcp", name: "github", scope: "plugin", meta: { plugin: "eng" } });
		const s = session({});
		use(gh, s);
		use(plug, s);
		db.prepare(
			"INSERT INTO tool_calls (session_id, tool_name, mcp_server, mcp_source, started_at, ok) VALUES (?, 'mcp__github__x', 'github', NULL, ?, 1)",
		).run(s, daysAgo(1));
		expect(run(unusedMcp).map((f) => f.evidence.key)).toEqual([String(plug)]);
	});
});

describe("cache_hit_dip", () => {
	/** A day with one session at the given cache share of 1000 input-side tokens. */
	const day = (ago: number, share: number, minutes = 30, id?: string) =>
		session({
			id,
			at: daysAgo(ago),
			minutes,
			usage: [{ input: 1000 - share * 1000, cacheRead: share * 1000 }],
		});

	it("flags a day more than 15 points below the 30-day median with its sessions", () => {
		for (const ago of [2, 3, 4, 5, 6]) day(ago, 0.78);
		const long = day(1, 0.54, 150, "long-1"); // Thu 1 Oct, over 2 h, no compaction
		day(1, 0.54, 30, "short-1");
		const findings = run(cacheHitDip);
		expect(findings).toEqual([
			{
				rule: "cache_hit_dip",
				at: new Date(2026, 9, 1).toISOString(), // local midnight of the dip day
				severity: "low",
				message: "Thu cache hit 54% vs usual 78% · 1 session over 2 h without compaction",
				evidence: {
					key: "2026-10-01",
					day: "2026-10-01",
					share: 0.54,
					median: 0.78,
					sessions: [long, "short-1"].sort(),
					longSessions: [long],
				},
				costTokens: Math.round(0.24 * 2000),
				target: "overview",
			},
		]);
	});

	it("does not flag a day 10 points below", () => {
		for (const ago of [2, 3, 4, 5, 6]) day(ago, 0.78);
		day(1, 0.68);
		expect(run(cacheHitDip)).toEqual([]);
	});
});

describe("model_mix", () => {
	it("flags exploration sessions on the most expensive model with their share of cost (non-cached tokens)", () => {
		for (let i = 0; i < 5; i++)
			session({ type: "exploration", usage: [{ model: "claude-opus-4-1", input: 100, cacheRead: 4000, cost: 0.62 }] });
		session({ type: "feature", usage: [{ model: "claude-opus-4-1", input: 100, cost: 3 }] });
		session({ type: "exploration", usage: [{ model: "claude-sonnet-4-5", input: 100, cost: 3.9 }] });
		const [f] = run(modelMix);
		expect(f).toMatchObject({
			rule: "model_mix",
			severity: "low",
			message: "5 exploration sessions on Opus = 31% of cost",
			costTokens: 500,
			target: "session",
		});
		expect(f.evidence).toMatchObject({ key: "claude-opus-4-1", model: "claude-opus-4-1", count: 5, pct: 31 });
		expect(f.evidence.sessions).toHaveLength(5);
	});

	it("does not fire when exploration ran only on a cheaper model", () => {
		session({ type: "feature", usage: [{ model: "claude-opus-4-1", input: 100, cost: 3 }] });
		session({ type: "exploration", usage: [{ model: "claude-sonnet-4-5", input: 100, cost: 1 }] });
		expect(run(modelMix)).toEqual([]);
	});

	it("ignores sessions outside the last 7 days", () => {
		session({ type: "exploration", at: daysAgo(9), usage: [{ model: "claude-opus-4-1", input: 100, cost: 1 }] });
		expect(run(modelMix)).toEqual([]);
	});
});

describe("tool_failure_hotspot", () => {
	const fail = (sessionId: string, command: string, ago: number) => {
		const turn = Number(
			db.prepare("INSERT INTO turns (session_id, seq) VALUES (?, ?)").run(sessionId, ++n).lastInsertRowid,
		);
		// 100 non-cached tokens per failing turn; cache reads are left out of the cost
		db.prepare(
			"INSERT INTO usage (session_id, turn_id, input_tokens, cache_read_tokens, ts) VALUES (?, ?, 100, 900, ?)",
		).run(sessionId, turn, daysAgo(ago));
		db.prepare(
			"INSERT INTO tool_calls (session_id, turn_id, tool_name, input, started_at, ok, exit_code) VALUES (?, ?, 'Bash', ?, ?, 0, 1)",
		).run(sessionId, turn, encodePayload({ command }), daysAgo(ago));
	};

	it("flags 3 failures of one key in one repo within 7 days", () => {
		const a = session({ repo: "ra" });
		const b = session({ repo: "ra" });
		fail(a, "pytest -x", 1);
		fail(a, "pytest tests/", 2);
		fail(b, "python -m pytest", 3);
		fail(b, "pytest", 9); // older than 7 days
		const [f] = run(toolFailureHotspot);
		expect(f).toEqual({
			rule: "tool_failure_hotspot",
			severity: "low",
			message: "`Bash: pytest` failed 3 times in `app` this week",
			evidence: { key: "ra|Bash: pytest", tool: "Bash: pytest", repoId: "ra", count: 3, sessions: [a, b].sort() },
			costTokens: 300,
			target: "repos",
		});
	});

	it("does not flag 2 failures, 3 spread over two repos, or denied calls", () => {
		const a = session({ repo: "ra" });
		const b = session({ repo: "rb" });
		fail(a, "pytest", 1);
		fail(a, "pytest", 1);
		fail(b, "pytest", 1);
		db.prepare(
			"INSERT INTO tool_calls (session_id, tool_name, input, started_at, ok, denied) VALUES (?, 'Bash', ?, ?, 0, 'user')",
		).run(a, encodePayload({ command: "pytest" }), daysAgo(1));
		expect(run(toolFailureHotspot)).toEqual([]);
	});
});

describe("runDigestRules", () => {
	const seedUnusedSkill = () => {
		const pdf = item({ kind: "skill", name: "pdf", desc: "dddd" });
		use(pdf, session({}));
		return pdf;
	};
	const digestRows = () =>
		db
			.prepare(
				"SELECT rule, subject_key, dismissed_until, created_at FROM findings WHERE session_id IS NULL ORDER BY rule",
			)
			.all<{ rule: string; subject_key: string; dismissed_until: string | null; created_at: string }>();

	it("replaces session-less findings of the five rules and returns the count", () => {
		expect(DIGEST_RULES.map((r) => r.rule)).toEqual([
			"unused_skill",
			"unused_mcp",
			"cache_hit_dip",
			"model_mix",
			"tool_failure_hotspot",
			"spend_spike",
			"budget_over",
		]);
		const pdf = seedUnusedSkill();
		expect(runDigestRules(db, NOW)).toBe(1);
		const later = new Date(NOW.getTime() + 3_600_000);
		expect(runDigestRules(db, later)).toBe(1);
		expect(digestRows()).toEqual([
			{ rule: "unused_skill", subject_key: String(pdf), dismissed_until: null, created_at: later.toISOString() },
		]);
	});

	it("keeps a digest finding's feedback across recomputes, so a restart does not reset the vote (review B3)", () => {
		seedUnusedSkill();
		runDigestRules(db, NOW);
		const id = db.prepare("SELECT id FROM findings WHERE session_id IS NULL").get<{ id: number }>()?.id as number;
		recordFeedback(db, id, "not_helpful", NOW);
		runDigestRules(db, NOW);
		expect(db.prepare("SELECT id, feedback FROM findings WHERE session_id IS NULL").all()).toEqual([
			{ id, feedback: "not_helpful" },
		]);
		// voting again after the restart changes nothing
		recordFeedback(db, id, "not_helpful", NOW);
		expect(db.prepare("SELECT not_helpful FROM rule_feedback WHERE rule = 'unused_skill'").get()).toEqual({
			not_helpful: 1,
		});
	});

	it("copies a future dismissal from meta onto the recomputed finding", () => {
		const pdf = seedUnusedSkill();
		const until = new Date(NOW.getTime() + 20 * 86_400_000).toISOString();
		setMeta(db, `dismiss:unused_skill:${pdf}`, until);
		setMeta(db, "dismiss:unused_skill:999", until);
		runDigestRules(db, NOW);
		expect(digestRows()[0].dismissed_until).toBe(until);
		setMeta(db, `dismiss:unused_skill:${pdf}`, new Date(NOW.getTime() - 1000).toISOString());
		runDigestRules(db, NOW);
		expect(digestRows()[0].dismissed_until).toBeNull();
	});

	it("logs a throwing rule and keeps its old rows; the others are still written", () => {
		seedUnusedSkill();
		db.prepare(
			"INSERT INTO findings (rule, subject_key, severity, message, evidence, created_at) VALUES ('model_mix', 'old', 'low', 'm', '{}', 't')",
		).run();
		const boom: DigestRule = {
			rule: "model_mix",
			run() {
				throw new Error("bad row");
			},
		};
		const rules = DIGEST_RULES.map((r) => (r.rule === "model_mix" ? boom : r));
		expect(runDigestRules(db, NOW, rules)).toBe(1);
		expect(digestRows().map((r) => [r.rule, r.subject_key])).toEqual([
			["model_mix", "old"],
			["unused_skill", expect.any(String)],
		]);
		const log = join(h.home, "coach-errors.log");
		expect(existsSync(log) && readFileSync(log, "utf8")).toMatch(/\tmodel_mix\tbad row\n$/);
	});

	it("leaves session findings alone", () => {
		const s = session({});
		db.prepare(
			"INSERT INTO findings (session_id, rule, severity, message, evidence, created_at) VALUES (?, 'retry_loop', 'low', 'm', '{}', 't')",
		).run(s);
		runDigestRules(db, NOW);
		expect(db.prepare("SELECT count(*) AS n FROM findings WHERE session_id IS NOT NULL").get()).toEqual({ n: 1 });
	});
});

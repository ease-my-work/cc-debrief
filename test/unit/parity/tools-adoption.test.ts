// Phase 7 Task 12 (P10): tool categories, feature adoption and Claude Code versions.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../../../src/db/adapter";
import { migrate } from "../../../src/db/migrate";
import { getAdoption, getVersions } from "../../../src/db/queries/adoption";
import { getToolStats } from "../../../src/db/queries/tools";
import { TOOL_CATEGORIES, toolCategory } from "../../../src/derive/tool-categories";
import { fixtureJsonlFiles } from "../../helpers/fixtures";
import { localAt, PARITY_NOW, seedParitySession } from "../../helpers/parity-seed";

describe("toolCategory", () => {
	it("gives every built-in tool in the Phase 0 fixtures a category other than other", () => {
		const names = new Set<string>();
		for (const f of fixtureJsonlFiles())
			for (const m of readFileSync(f, "utf8").matchAll(/"type":"tool_use","id":"[^"]*","name":"([^"]+)"/g))
				if (!m[1].startsWith("mcp__")) names.add(m[1]);
		expect(names.size).toBeGreaterThan(5);
		for (const n of names) expect(toolCategory(n, null), n).not.toBe("other");
	});

	it("maps MCP calls and Skill by kind, and unknown tools to other", () => {
		expect(toolCategory("mcp__github__create_issue", "github")).toBe("mcp");
		expect(toolCategory("Skill", null)).toBe("skills");
		expect(toolCategory("TaskCreate", null)).toBe("tasks_plans");
		expect(toolCategory("ExitPlanMode", null)).toBe("tasks_plans");
		expect(toolCategory("WebSearch", null)).toBe("web");
		expect(toolCategory("Grep", null)).toBe("search");
		expect(toolCategory("MultiEdit", null)).toBe("file_edit");
		expect(toolCategory("SomethingNew", null)).toBe("other");
		expect(TOOL_CATEGORIES).toContain("other");
	});
});

describe("adoption and versions", () => {
	let db: Db;
	beforeEach(() => {
		db = openDb(":memory:");
		migrate(db);
	});
	afterEach(() => db.close());

	const call = (id: string, tool: string, mcp: string | null = null) =>
		db
			.prepare("INSERT INTO tool_calls (session_id, tool_name, mcp_server, ok, started_at) VALUES (?, ?, ?, 1, ?)")
			.run(id, tool, mcp, localAt(1));

	it("shares of sessions per feature; plan mode from either source counted once", () => {
		const s = (id: string, mode: string | null = null) =>
			seedParitySession(db, id, { startedAt: localAt(1), permissionMode: mode });
		s("plan-start", "plan");
		call("plan-start", "EnterPlanMode"); // both sources: still one session
		s("plan-call");
		call("plan-call", "EnterPlanMode");
		s("auto", "auto");
		call("auto", "WebFetch");
		call("auto", "mcp__gh__x", "gh");
		s("agent");
		db.prepare("INSERT INTO subagents (session_id, agent_id, agent_type) VALUES ('agent', 'a1', 'Explore')").run();
		call("agent", "Skill");
		seedParitySession(db, "old", { startedAt: localAt(40), permissionMode: "plan" });
		const rows = getAdoption(db, { range: "7d", now: PARITY_NOW });
		expect(rows).toEqual([
			{ feature: "plan_mode", sessions: 2, share: 0.5 },
			{ feature: "subagents", sessions: 1, share: 0.25 },
			{ feature: "skills", sessions: 1, share: 0.25 },
			{ feature: "mcp", sessions: 1, share: 0.25 },
			{ feature: "web", sessions: 1, share: 0.25 },
			{ feature: "auto_mode", sessions: 1, share: 0.25 },
		]);
		expect(getAdoption(db, { range: "today", now: PARITY_NOW }).every((r) => r.share === 0)).toBe(true);
	});

	it("versions sort by version number, not text, with first and last seen", () => {
		const v = (id: string, version: string, daysAgo: number) =>
			seedParitySession(db, id, { startedAt: localAt(daysAgo), ccVersion: version });
		v("a", "2.1.9", 10);
		v("b", "2.1.10", 5);
		v("c", "2.1.10", 2);
		v("d", "2.0.99", 30);
		seedParitySession(db, "e", { startedAt: localAt(1), ccVersion: null });
		expect(getVersions(db)).toEqual([
			{ version: "2.1.10", firstSeen: localAt(5), lastSeen: localAt(2), sessions: 2 },
			{ version: "2.1.9", firstSeen: localAt(10), lastSeen: localAt(10), sessions: 1 },
			{ version: "2.0.99", firstSeen: localAt(30), lastSeen: localAt(30), sessions: 1 },
		]);
	});

	it("tool stats carry their category", () => {
		seedParitySession(db, "x", { startedAt: localAt(1) });
		call("x", "Read");
		call("x", "TaskUpdate");
		const byName = Object.fromEntries(
			getToolStats(db, { range: "7d", now: PARITY_NOW }).map((t) => [t.name, t.category]),
		);
		expect(byName).toEqual({ Read: "file_read", TaskUpdate: "tasks_plans" });
	});
});

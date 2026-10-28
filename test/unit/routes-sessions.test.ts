import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setConfigValue } from "../../src/config";
import type { Db } from "../../src/db/adapter";
import { getSessionDetail, listSessions } from "../../src/db/queries/sessions";
import { sessionTotals } from "../../src/db/queries/usage";
import { createApp } from "../../src/server/app";
import type { ApiError, SessionDetail, SessionsResponse } from "../../src/server/types";
import { seedDb } from "../helpers/seed";
import { at, MYSTERY, OPUS, REPO_API, REPO_APP, S, SMALL_NOW, SONNET, seedSmall } from "../helpers/seed-small";
import { type TmpHome, tmpHome } from "../helpers/tmp-home";

let h: TmpHome;
let db: Db;
beforeEach(() => {
	h = tmpHome();
	db = seedDb();
	seedSmall(db);
	// Routes read the real clock: pin it to the fixture's NOW so range windows stay put.
	vi.useFakeTimers({ now: SMALL_NOW, toFake: ["Date"] });
});
afterEach(() => {
	vi.useRealTimers();
	db.close();
	h.cleanup();
});

const list = (q: Partial<Parameters<typeof listSessions>[1]> = {}) =>
	listSessions(db, { range: "7d", now: SMALL_NOW, ...q });

describe("listSessions", () => {
	it("lists the range newest first with flags, totals and summary lines", () => {
		const r = list();
		expect(r.total).toBe(5);
		expect(r.nextCursor).toBeNull();
		expect(r.items.map((i) => i.id)).toEqual([S.s4, S.s1, S.s2, S.s3, S.s5]);
		const by = Object.fromEntries(r.items.map((i) => [i.id, i]));
		expect(by[S.s1]).toEqual({
			id: S.s1,
			startedAt: at(10, 1, 10),
			endedAt: at(10, 1, 10, 30),
			surface: "cli",
			repo: { id: REPO_APP, name: "app" },
			type: null,
			typeSource: null,
			summaryLine: "Please fix the alembic migration",
			tokens: 2000,
			costUsd: 0.15,
			partial: true,
			tokensUnknown: false,
			durationSec: 1800,
			models: [SONNET],
			review: null,
			inProgress: false,
			imported: false,
		});
		expect(by[S.s2]).toMatchObject({
			summaryLine: "Add login page",
			tokens: 3000,
			costUsd: 1.5,
			partial: false,
			models: [OPUS],
		});
		expect(by[S.s3]).toMatchObject({
			imported: true,
			costUsd: null,
			tokensUnknown: false,
			models: [MYSTERY],
			summaryLine: "Explain the scheduler",
		});
		expect(by[S.s4]).toMatchObject({ inProgress: true, endedAt: null, durationSec: null, repo: null });
		expect(by[S.s5]).toMatchObject({ tokens: 0, costUsd: null, tokensUnknown: true });
	});

	it("agrees with sessionTotals() for every session", () => {
		for (const item of list({ range: "30d" }).items) {
			const t = sessionTotals(db, item.id);
			const tokens =
				t.tokens.inputTokens + t.tokens.outputTokens + t.tokens.cacheCreationTokens + t.tokens.cacheReadTokens;
			expect(item.tokens, item.id).toBe(tokens);
			expect(item.partial, item.id).toBe(t.source === "counted");
			// With no usage rows at all the list shows no cost (null) where sessionTotals() says 0.
			if (tokens > 0 && t.costUsd === null) expect(item.costUsd, item.id).toBeNull();
			else if (tokens > 0) expect(item.costUsd, item.id).toBeCloseTo(t.costUsd ?? 0, 6);
		}
	});

	it("honours the range", () => {
		expect(list({ range: "today" }).items.map((i) => i.id)).toEqual([S.s4]);
		expect(list({ range: "30d" }).total).toBe(6);
	});

	it("filters by repo", () => {
		expect(list({ repo: REPO_API }).items.map((i) => i.id)).toEqual([S.s2]);
	});

	it("searches prompt text case-insensitively", () => {
		expect(list({ q: "ALEMBIC" }).items.map((i) => i.id)).toEqual([S.s1]);
		expect(list({ q: "alembic" }).total).toBe(1);
	});

	it("treats % and _ in the query literally", () => {
		expect(list({ q: "50%" }).items.map((i) => i.id)).toEqual([S.s2]);
		expect(list({ q: "%" }).items.map((i) => i.id)).toEqual([S.s2]);
		expect(list({ q: "_" }).items).toEqual([]);
	});

	it("searches stored summaries too", () => {
		db.prepare("UPDATE sessions SET summary = 'Refactored the payment retry loop.' WHERE session_id = ?").run(S.s5);
		expect(list({ q: "retry loop" }).items.map((i) => i.id)).toEqual([S.s5]);
	});

	it("pages with an opaque cursor, without duplicates", () => {
		const seen: string[] = [];
		let cursor: string | undefined;
		let pages = 0;
		do {
			const r = list({ limit: 2, cursor });
			seen.push(...r.items.map((i) => i.id));
			expect(r.total).toBe(5);
			cursor = r.nextCursor ?? undefined;
			pages++;
		} while (cursor);
		expect(pages).toBe(3);
		expect(seen).toEqual([S.s4, S.s1, S.s2, S.s3, S.s5]);
	});
});

describe("getSessionDetail", () => {
	it("returns turns with tool chips, files, used items, subagents and compactions", () => {
		const d = getSessionDetail(db, S.s1, SMALL_NOW) as SessionDetail;
		expect(d.resumeCommand).toBe(`claude --resume ${S.s1}`);
		expect(d.summaryState).toBe("pending");
		expect(d.tokens).toEqual({
			input: 200,
			cacheWrite: 200,
			cacheRead: 1500,
			output: 100,
			costUsd: 0.15,
			byModel: [{ model: SONNET, tokens: 2000, costUsd: 0.15 }],
			unknown: false,
		});
		expect(d.turns).toEqual([
			{
				seq: 1,
				startedAt: at(10, 1, 10),
				userText: "Please fix the alembic migration",
				assistantExcerpt: `${"a".repeat(299)}…`,
				tools: [
					{ label: "Bash npm", count: 2, totalMs: 3000, failures: 1, denials: 0 },
					{ label: "Grep", count: 1, totalMs: 500, failures: 0, denials: 0 },
					{ label: "mcp__github__search_code", count: 1, totalMs: 1800, failures: 0, denials: 0 },
					{ label: "Agent", count: 1, totalMs: 60000, failures: 0, denials: 0 },
					{ label: "Skill", count: 1, totalMs: 100, failures: 0, denials: 0 },
				],
			},
			{
				seq: 2,
				startedAt: at(10, 1, 10, 15),
				userText: "Run it again",
				assistantExcerpt: "Done.",
				tools: [{ label: "Write", count: 1, totalMs: 5000, failures: 0, denials: 1 }],
			},
		]);
		expect(d.toolCallCount).toBe(9);
		// the same relative path in another repo is its own row (review A6)
		db.prepare(
			"INSERT INTO file_changes (session_id, repo_id, path, lines_added, lines_removed, language) VALUES (?, ?, 'README.md', 1, 0, 'markdown')",
		).run(S.s1, REPO_API);
		const files = (getSessionDetail(db, S.s1, SMALL_NOW) as SessionDetail).files;
		expect(files.filter((f) => f.path === "README.md").map((f) => [f.repo, f.added])).toEqual([
			["app", 3],
			["api", 1],
		]);
		db.prepare("DELETE FROM file_changes WHERE session_id = ? AND repo_id = ?").run(S.s1, REPO_API);
		expect(d.files).toEqual([
			{ path: "src/a.ts", added: 10, removed: 2, language: "typescript", repo: "app" },
			{ path: "src/b.ts", added: 5, removed: 0, language: "typescript", repo: "app" },
			{ path: "README.md", added: 3, removed: 1, language: "markdown", repo: "app" },
		]);
		// Calls include subagent calls; a denied call (Write) is not a failure (feature 03).
		expect(d.used).toEqual({
			skills: [{ name: "code-review", calls: 1, failures: 0 }],
			mcpServers: [{ name: "github", calls: 1, failures: 0 }],
			tools: [
				{ name: "Bash", calls: 2, failures: 1 },
				{ name: "Grep", calls: 2, failures: 0 },
				{ name: "Agent", calls: 1, failures: 0 },
				{ name: "Read", calls: 1, failures: 0 },
				{ name: "Skill", calls: 1, failures: 0 },
				{ name: "Write", calls: 1, failures: 0 },
			],
			instructionFiles: [{ path: "/w/app/CLAUDE.md", kind: "Project", count: 2 }],
		});
		expect(d.subagents).toEqual([
			{ agentId: "ag1", agentType: "Explore", description: "find tests", turnSeq: 1, toolCalls: 2 },
		]);
		expect(d.compactions).toEqual([{ ts: at(10, 1, 10, 10), trigger: "manual", afterTurnSeq: 1 }]);
		expect(d).toMatchObject({
			cwd: "/w/app",
			startReason: "startup",
			permissionMode: "default",
			inProgress: false,
			// Phase 4: the band is always there; no findings stored for this seed.
			review: {
				state: "disabled",
				estUsd: null,
				findings: [],
				tier2: null,
				dismissedUntil: null,
				permissionPrompts: "recorded",
				nudgeDismissed: false,
			},
		});
	});

	it("reports tokens unknown for a session without usage rows", () => {
		const d = getSessionDetail(db, S.s5, SMALL_NOW) as SessionDetail;
		expect(d.tokens).toEqual({
			input: 0,
			cacheWrite: 0,
			cacheRead: 0,
			output: 0,
			costUsd: null,
			byModel: [],
			unknown: true,
		});
	});

	it("uses the reported totals of a session with a cost-state line", () => {
		const d = getSessionDetail(db, S.s2, SMALL_NOW) as SessionDetail;
		expect(d.tokens).toMatchObject({
			input: 300,
			cacheWrite: 100,
			cacheRead: 2400,
			output: 200,
			costUsd: 1.5,
			unknown: false,
		});
		expect(d.tokens.byModel).toEqual([{ model: OPUS, tokens: 3000, costUsd: 1.5 }]);
	});

	it("marks summaries disabled when the setting is off", () => {
		setConfigValue("ai.summaries.enabled", "false");
		expect((getSessionDetail(db, S.s1, SMALL_NOW) as SessionDetail).summaryState).toBe("disabled");
	});

	it("returns null for an unknown id", () => {
		expect(getSessionDetail(db, "nope", SMALL_NOW)).toBeNull();
	});
});

describe("sessions routes", () => {
	const get = (path: string) =>
		createApp(db, { port: 4242, uiDir: "/x" }).request(path, { headers: { host: "localhost:4242" } });

	it("GET /api/sessions returns a SessionsResponse", async () => {
		// range=all: the fixture is dated around SMALL_NOW, and the route ranges from the real clock.
		const r = await get("/api/sessions?range=all&limit=1");
		expect(r.status).toBe(200);
		const body = (await r.json()) as SessionsResponse;
		expect(body.items).toHaveLength(1);
		expect(body.total).toBe(6);
		expect(body.nextCursor).toEqual(expect.any(String));
	});

	it("rejects bad parameters with 400", async () => {
		for (const q of ["range=year", "limit=0", "limit=101", "limit=x", "cursor=%%%", "type=nonsense"]) {
			const r = await get(`/api/sessions?${q}`);
			expect(r.status, q).toBe(400);
			expect(((await r.json()) as ApiError).error.code).toBe("bad_request");
		}
	});

	it("GET /api/sessions/:id returns the detail, 404 for an unknown id", async () => {
		expect((await get(`/api/sessions/${S.s1}`)).status).toBe(200);
		const r = await get("/api/sessions/nope");
		expect(r.status).toBe(404);
		expect(((await r.json()) as ApiError).error.code).toBe("not_found");
	});
});

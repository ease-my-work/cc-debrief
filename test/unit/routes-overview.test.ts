import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/adapter";
import { getOverview, rangeStart } from "../../src/db/queries/overview";
import { createApp } from "../../src/server/app";
import type { ApiError, Overview } from "../../src/server/types";
import { seedDb } from "../helpers/seed";
import { REPO_API, REPO_APP, S, SMALL_NOW, seedSmall } from "../helpers/seed-small";
import { OVERVIEW_7D_TILES, TOKENS_PER_DAY_7D } from "../helpers/seed-small.expected";
import { type TmpHome, tmpHome } from "../helpers/tmp-home";

let h: TmpHome;
let db: Db;
beforeEach(() => {
	h = tmpHome();
	db = seedDb();
	seedSmall(db);
});
afterEach(() => {
	db.close();
	h.cleanup();
});

describe("getOverview", () => {
	it("computes the 7-day tiles from session totals", () => {
		expect(getOverview(db, { range: "7d", now: SMALL_NOW }).tiles).toEqual(OVERVIEW_7D_TILES);
	});

	it("gives one zero-filled entry per local day whose columns sum to the token tile", () => {
		const o = getOverview(db, { range: "7d", now: SMALL_NOW });
		expect(o.tokensPerDay).toEqual(TOKENS_PER_DAY_7D);
		const sum = o.tokensPerDay.reduce((n, d) => n + d.input + d.cacheRead + d.output, 0);
		expect(sum).toBe(o.tiles.tokens.total);
	});

	it("lists the last five sessions, newest first", () => {
		expect(getOverview(db, { range: "7d", now: SMALL_NOW }).recent.map((s) => s.id)).toEqual([
			S.s4,
			S.s1,
			S.s2,
			S.s3,
			S.s5,
		]);
	});

	it("counts only the chosen repo's sessions", () => {
		const o = getOverview(db, { range: "7d", repo: REPO_APP, now: SMALL_NOW });
		expect(o.tiles.sessions).toEqual({
			total: 3,
			bySurface: { cli: 2, vscode: 0, desktop: 1, unknown: 0 },
			byRepo: [{ repoId: REPO_APP, name: "app", sessions: 3 }],
		});
		expect(o.tiles.lines).toEqual({ added: 18, removed: 3, files: 3, repos: 1 });
		expect(o.recent.map((s) => s.id)).toEqual([S.s1, S.s3, S.s5]);
	});

	it("counts only the chosen repo's files when a session also edits another repo", () => {
		db.prepare(
			"INSERT INTO file_changes (session_id, repo_id, path, lines_added, lines_removed, language) VALUES (?, ?, ?, ?, ?, ?)",
		).run(S.s1, REPO_API, "../api/x.ts", 50, 7, "typescript");
		const o = getOverview(db, { range: "7d", repo: REPO_APP, now: SMALL_NOW });
		expect(o.tiles.lines).toEqual({ added: 18, removed: 3, files: 3, repos: 1 });
		expect(getOverview(db, { range: "7d", now: SMALL_NOW }).tiles.lines.added).toBe(18 + 40 + 50);
	});

	it("covers 30 days with 30 entries and includes older sessions", () => {
		const o = getOverview(db, { range: "30d", now: SMALL_NOW });
		expect(o.tokensPerDay).toHaveLength(30);
		expect(o.tokensPerDay.at(-1)?.date).toBe("2026-10-02");
		expect(o.tiles.sessions.total).toBe(6);
		expect(o.tiles.tokens.total).toBe(6200);
	});

	it("counts today from local midnight", () => {
		const justAfterMidnight = new Date(2026, 9, 3, 0, 30);
		db.prepare(
			"INSERT INTO sessions (session_id, started_at, ended_at, surface) VALUES ('late', ?, ?, 'cli'), ('early', ?, ?, 'cli')",
		).run(
			new Date(2026, 9, 2, 23, 50).toISOString(),
			new Date(2026, 9, 2, 23, 55).toISOString(),
			new Date(2026, 9, 3, 0, 10).toISOString(),
			new Date(2026, 9, 3, 0, 20).toISOString(),
		);
		expect(rangeStart("today", justAfterMidnight)).toBe(new Date(2026, 9, 3).toISOString());
		const o = getOverview(db, { range: "today", now: justAfterMidnight });
		expect(o.tiles.sessions.total).toBe(1);
		expect(o.recent.map((s) => s.id)).toEqual(["early"]);
		expect(o.tokensPerDay.map((d) => d.date)).toEqual(["2026-10-03"]);
	});

	it("handles an empty DB", () => {
		const empty = seedDb({ ...process.env, CC_DEBRIEF_DB: `${h.home}/empty.db` });
		try {
			const o = getOverview(empty, { range: "7d", now: SMALL_NOW });
			expect(o.tiles.sessions.total).toBe(0);
			expect(o.tiles.tokens).toEqual({ total: 0, cacheServedPct: 0 });
			expect(o.tiles.cost).toEqual({ usd: 0, byModel: [], unknownModelTokens: 0 });
			expect(o.tokensPerDay).toHaveLength(7);
			expect(o.recent).toEqual([]);
			expect(o.chartNote).toBeNull();
		} finally {
			empty.close();
		}
	});
});

describe("GET /api/overview", () => {
	const get = (q: string) =>
		createApp(db, { port: 4242, uiDir: "/x" }).request(`/api/overview${q}`, { headers: { host: "localhost:4242" } });

	it("returns an Overview with the 7-day default", async () => {
		const r = await get("");
		expect(r.status).toBe(200);
		const body = (await r.json()) as Overview;
		expect(body.tokensPerDay).toHaveLength(7);
		expect(Object.keys(body.tiles)).toEqual(["sessions", "tokens", "cost", "lines"]);
	});

	it("rejects an unknown range with 400", async () => {
		const r = await get("?range=year");
		expect(r.status).toBe(400);
		expect(((await r.json()) as ApiError).error.code).toBe("bad_request");
	});
});

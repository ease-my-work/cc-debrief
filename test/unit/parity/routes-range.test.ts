// Phase 7 Task 3 (P1): every route that takes a range accepts 90d and all, and rejects anything else with 400.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../../src/db/adapter";
import { getOverview } from "../../../src/db/queries/overview";
import { createApp } from "../../../src/server/app";
import type { Overview } from "../../../src/server/types";
import { seedDb } from "../../helpers/seed";
import { SMALL_NOW, seedSmall } from "../../helpers/seed-small";
import { type TmpHome, tmpHome } from "../../helpers/tmp-home";

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

const ROUTES = [
	"/api/overview",
	"/api/improvements",
	"/api/sessions",
	"/api/inventory",
	"/api/tools",
	"/api/repos",
	"/api/findings",
	"/api/adoption",
	"/api/activity",
	"/api/costs",
	"/api/tasks-plans",
];
const get = (path: string) =>
	createApp(db, { port: 4242, uiDir: "/nonexistent" }).request(path, { headers: { host: "localhost:4242" } });

describe("range values", () => {
	it.each(ROUTES)("%s accepts 90d and all", async (route) => {
		for (const range of ["90d", "all"]) {
			const res = await get(`${route}?range=${range}`);
			expect(res.status, `${route}?range=${range}`).toBe(200);
		}
	});
	it.each(ROUTES)("%s rejects 1y with 400", async (route) => {
		const res = await get(`${route}?range=1y`);
		expect(res.status).toBe(400);
	});
	it("all counts every retained session; 90d equals all on a recent fixture", () => {
		const all = getOverview(db, { range: "all", now: SMALL_NOW });
		const total = db.prepare("SELECT count(*) AS n FROM sessions").get<{ n: number }>()?.n;
		expect(all.tiles.sessions.total).toBe(total);
		expect(getOverview(db, { range: "90d", now: SMALL_NOW }).tiles).toEqual(all.tiles);
	});
	it("the Overview chart over all starts at the oldest session's day and sums to the token tile", async () => {
		const o = (await (await get("/api/overview?range=all")).json()) as Overview;
		const sum = o.tokensPerDay.reduce((n, d) => n + d.input + d.cacheRead + d.output, 0);
		expect(sum).toBe(o.tiles.tokens.total);
		expect(o.tokensPerDay.length).toBeGreaterThan(0);
	});

	it("the Overview chart over all drops days older than 366 and says so (final review I3)", () => {
		db.prepare("INSERT INTO sessions (session_id, started_at, ended_at) VALUES ('ancient', ?, ?)").run(
			new Date(SMALL_NOW.getTime() - 400 * 86_400_000).toISOString(),
			new Date(SMALL_NOW.getTime() - 400 * 86_400_000 + 60_000).toISOString(),
		);
		db.prepare(
			"INSERT INTO usage (session_id, model, input_tokens, ts) VALUES ('ancient', 'claude-sonnet-4-5', 777777, ?)",
		).run(new Date(SMALL_NOW.getTime() - 400 * 86_400_000).toISOString());
		const o = getOverview(db, { range: "all", now: SMALL_NOW });
		expect(o.tokensPerDay).toHaveLength(366);
		expect(o.tokensPerDay[0].input).toBe(0);
		expect(o.chartNote).toBe("Showing the newest 366 days; earlier days are not in the chart.");
	});
});

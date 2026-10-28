import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setConfigValue } from "../../src/config";
import type { Db } from "../../src/db/adapter";
import { createApp } from "../../src/server/app";
import type { ImprovementsResponse } from "../../src/server/types";
import { seedDb } from "../helpers/seed";
import { type TmpHome, tmpHome } from "../helpers/tmp-home";

const HOST = { host: "127.0.0.1:4242" };
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

const get = async () =>
	(await (
		await createApp(db, { port: 4242, uiDir: "/x" }).request("/api/improvements", { headers: HOST })
	).json()) as ImprovementsResponse;

describe("GET /api/improvements", () => {
	it("has no items yet and the full footer shape with the live self-usage line", async () => {
		const ago = new Date(Date.now() - 86_400_000).toISOString();
		db.prepare(
			"INSERT INTO self_usage (feature, session_id, input_tokens, cost_usd, ts) VALUES ('summary', 'a', 200000, 1.0, ?), ('review', 'b', 110000, 0.4, ?)",
		).run(ago, ago);
		db.prepare("INSERT INTO sessions (session_id) VALUES ('u')").run();
		db.prepare("INSERT INTO usage (session_id, model, cost_usd, ts) VALUES ('u', 'm', 18.4, ?)").run(ago);
		expect(await get()).toEqual({
			items: [],
			footer: {
				reviewsThisWeek: 0,
				reviewCostUsd: 0,
				dismissed: 0,
				eligibleUnreviewed: 0,
				estReviewAllUsd: 0,
				reviewsEnabled: false,
				nudgeDismissed: false,
				selfUsage: {
					summaries: 1,
					reviews: 1,
					drafts: 0,
					recaps: 0,
					tokens: 310_000,
					usd: 1.4,
					sharePct: expect.closeTo(7.07, 2),
				},
			},
		});
	});

	it("reflects reviews being enabled", async () => {
		setConfigValue("ai.review.enabled", "true");
		expect((await get()).footer.reviewsEnabled).toBe(true);
	});
});

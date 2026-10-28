// Phase 7 Task 6: the budget band's data rides on GET /api/overview and GET /api/costs.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { updateConfig } from "../../../src/config";
import type { Db } from "../../../src/db/adapter";
import { createApp } from "../../../src/server/app";
import type { CostsResponse, Overview } from "../../../src/server/types";
import { seedParitySession } from "../../helpers/parity-seed";
import { seedDb } from "../../helpers/seed";
import { type TmpHome, tmpHome } from "../../helpers/tmp-home";

let h: TmpHome;
let db: Db;
beforeEach(() => {
	h = tmpHome();
	db = seedDb();
	seedParitySession(db, "a", { startedAt: new Date().toISOString(), usage: [{ input: 1000, cost: 5 }] });
});
afterEach(() => {
	db.close();
	h.cleanup();
});

const get = async <T>(path: string) =>
	(await (
		await createApp(db, { port: 4242, uiDir: "/x" }).request(path, { headers: { host: "localhost:4242" } })
	).json()) as T;

describe("budget in the API", () => {
	it("is null on both views while no budget is set", async () => {
		expect((await get<Overview>("/api/overview")).budget).toBeNull();
		expect((await get<CostsResponse>("/api/costs")).budget).toBeNull();
	});

	it("carries the month's state once a budget is set", async () => {
		updateConfig({ set: { "budget.monthlyUsd": 1000 } });
		const o = await get<Overview>("/api/overview");
		expect(o.budget).toMatchObject({ budgetUsd: 1000, monthToDateUsd: 5 });
		expect((await get<CostsResponse>("/api/costs")).budget).toEqual(o.budget);
	});
});

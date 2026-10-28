// Phase 7 Task 10: GET /api/sessions/:id/replay.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../../src/db/adapter";
import { createApp } from "../../../src/server/app";
import type { ReplayResponse } from "../../../src/server/types";
import { seedParitySession } from "../../helpers/parity-seed";
import { seedDb } from "../../helpers/seed";
import { type TmpHome, tmpHome } from "../../helpers/tmp-home";

let h: TmpHome;
let db: Db;
beforeEach(() => {
	h = tmpHome();
	db = seedDb();
	seedParitySession(db, "abc", { startedAt: new Date().toISOString(), prompt: "hello there", usage: [{ input: 5 }] });
});
afterEach(() => {
	db.close();
	h.cleanup();
});

const get = (path: string) =>
	createApp(db, { port: 4242, uiDir: "/x" }).request(path, { headers: { host: "localhost:4242" } });

describe("GET /api/sessions/:id/replay", () => {
	it("returns the turns", async () => {
		const r = await get("/api/sessions/abc/replay");
		expect(r.status).toBe(200);
		const body = (await r.json()) as ReplayResponse;
		expect(body.turns.map((t) => t.userText)).toEqual(["hello there"]);
	});
	it("404 for an unknown session", async () => {
		expect((await get("/api/sessions/nope/replay")).status).toBe(404);
	});
});

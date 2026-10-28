// Phase 7 Task 5: GET /api/costs — params, shape and the leak assertion (no prompt text, no full path).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../../src/db/adapter";
import { createApp } from "../../../src/server/app";
import type { CostsResponse } from "../../../src/server/types";
import { LEAK_FOLDER, LEAK_PROMPT, REPO_A, seedParitySession } from "../../helpers/parity-seed";
import { seedDb } from "../../helpers/seed";
import { type TmpHome, tmpHome } from "../../helpers/tmp-home";

let h: TmpHome;
let db: Db;
beforeEach(() => {
	h = tmpHome();
	db = seedDb();
	const recent = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
	seedParitySession(db, "leaky", {
		startedAt: recent(60),
		repo: { ...REPO_A, root: `/home/u/${LEAK_FOLDER}/api` },
		cwd: `/home/u/${LEAK_FOLDER}/api`,
		prompt: `fix ${LEAK_PROMPT} now`,
		usage: [{ input: 1000, output: 500, ts: recent(55) }],
	});
	db.prepare("INSERT INTO file_changes (session_id, repo_id, path, lines_added) VALUES (?, ?, ?, 3)").run(
		"leaky",
		REPO_A.id,
		`/home/u/${LEAK_FOLDER}/api/x.ts`,
	);
});
afterEach(() => {
	db.close();
	h.cleanup();
});

const get = (path: string) =>
	createApp(db, { port: 4242, uiDir: "/nonexistent" }).request(path, { headers: { host: "localhost:4242" } });

describe("GET /api/costs", () => {
	it("returns a CostsResponse for the range and repo", async () => {
		const r = await get(`/api/costs?range=7d&repo=${encodeURIComponent(REPO_A.id)}`);
		expect(r.status).toBe(200);
		const body = (await r.json()) as CostsResponse;
		expect(body.totalUsd).toBeGreaterThan(0);
		expect(body.byRepo).toEqual([{ repoId: REPO_A.id, name: "api", usd: body.totalUsd }]);
		expect(body.perDay).toHaveLength(7);
	});

	it("defaults to 30 days and rejects a bad range", async () => {
		expect(((await (await get("/api/costs")).json()) as CostsResponse).perDay).toHaveLength(30);
		expect((await get("/api/costs?range=1y")).status).toBe(400);
	});

	it("never carries prompt text or a full path", async () => {
		const text = await (await get("/api/costs?range=all")).text();
		expect(text).not.toContain(LEAK_PROMPT);
		expect(text).not.toContain(LEAK_FOLDER);
	});
});

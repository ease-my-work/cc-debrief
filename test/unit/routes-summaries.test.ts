import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setConfigValue } from "../../src/config";
import type { Db } from "../../src/db/adapter";
import { createApp } from "../../src/server/app";
import { waitForSummaryJob } from "../../src/server/jobs";
import type { SessionDetail, StatusResponse } from "../../src/server/types";
import { type FakeClaude, fakeClaude } from "../helpers/fake-claude";
import { seedDb } from "../helpers/seed";
import { HOUR, seedSummarizable } from "../helpers/seed-summary";
import { type TmpHome, tmpHome } from "../helpers/tmp-home";

const HOST = { host: "127.0.0.1:4242" };
const JSON_HEADERS = { ...HOST, "content-type": "application/json" };

let h: TmpHome;
let db: Db;
let fake: FakeClaude;
let restore: () => void;
beforeEach(() => {
	h = tmpHome();
	db = seedDb();
	fake = fakeClaude(h.home);
	restore = fake.install();
});
afterEach(async () => {
	await waitForSummaryJob();
	restore();
	db.close();
	h.cleanup();
});

const app = () => createApp(db, { port: 4242, uiDir: "/x" });
const get = async <T>(path: string) => (await (await app().request(path, { headers: HOST })).json()) as T;
const post = async (path: string, body: unknown = {}, headers: Record<string, string> = JSON_HEADERS) => {
	const r = await app().request(path, { method: "POST", headers, body: JSON.stringify(body) });
	return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};
const seed = (id: string, s: Parameters<typeof seedSummarizable>[3] = {}) =>
	seedSummarizable(db, h.claude, id, { file: "gone", ...s });

describe("POST /api/sessions/:id/summarize", () => {
	it("summarizes, imported sessions included (explicit request)", async () => {
		seed("imp", { capture: "backfill" });
		const r = await post("/api/sessions/imp/summarize");
		expect(r.status).toBe(200);
		expect(r.body).toEqual({ status: "done", costUsd: expect.any(Number), reason: null });
		expect((await get<SessionDetail>("/api/sessions/imp")).summaryState).toBe("done");
	});

	it("returns skipped, capped and error with a reason", async () => {
		seed("short", { turns: 1 });
		expect((await post("/api/sessions/short/summarize")).body).toMatchObject({
			status: "skipped",
			reason: "< 2 turns",
		});
		seed("s1");
		fake.scenario({ exitCode: 1, stderr: "nope" });
		const err = await post("/api/sessions/s1/summarize");
		expect(err.body).toMatchObject({ status: "error", costUsd: null });
		expect(String(err.body.reason)).toMatch(/^exit 1/);
		setConfigValue("ai.maxPerDay", "2"); // the two failed attempts used the cap
		seed("s2");
		expect((await post("/api/sessions/s2/summarize")).body).toMatchObject({ status: "capped" });
	});

	it("404 for an unknown session, 403 cross-origin", async () => {
		expect((await post("/api/sessions/nope/summarize")).status).toBe(404);
		seed("s1");
		const r = await post("/api/sessions/s1/summarize", {}, { ...JSON_HEADERS, origin: "https://evil.example" });
		expect(r.status).toBe(403);
		expect(fake.invocations()).toEqual([]);
	});
});

describe("session detail summary fields", () => {
	it("marks a 1-turn session skipped and gives the estimate and cap state", async () => {
		seed("short", { turns: 1 });
		seed("s1");
		expect((await get<SessionDetail>("/api/sessions/short")).summaryState).toBe("skipped");
		const d = await get<SessionDetail>("/api/sessions/s1");
		expect(d.summaryState).toBe("pending");
		expect(d.summaryCapReached).toBe(false);
		setConfigValue("ai.maxPerDay", "0");
		expect((await get<SessionDetail>("/api/sessions/s1")).summaryCapReached).toBe(true);
	});
});

describe("summary estimate and job", () => {
	beforeEach(() => {
		for (let i = 0; i < 3; i++) seed(`imp${i}`, { capture: "backfill", startedAgo: (10 - i) * HOUR });
		seed("old", { capture: "backfill", startedAgo: 40 * 24 * HOUR });
		db.prepare("INSERT INTO sessions (session_id) VALUES ('u')").run();
		db.prepare("INSERT INTO usage (session_id, model) VALUES ('u', 'claude-haiku-4-5')").run();
	});
	const since = () => new Date(Date.now() - 30 * 24 * HOUR).toISOString().slice(0, 10);

	it("GET /api/summaries/estimate counts pending sessions since the date", async () => {
		const e = await get<{ sessions: number; estUsd: number; capRemainingToday: number }>(
			`/api/summaries/estimate?since=${since()}`,
		);
		expect(e.sessions).toBe(3);
		expect(e.estUsd).toBeCloseTo(3 * ((8000 * 1 + 400 * 5) / 1e6), 9);
		expect(e.capRemainingToday).toBe(50);
		expect((await app().request("/api/summaries/estimate?since=nope", { headers: HOST })).status).toBe(400);
	});

	it("POST /api/summaries/run queues the sessions, reports progress in status, and refuses a second run", async () => {
		const r = await post("/api/summaries/run", { since: since() });
		expect(r).toEqual({ status: 200, body: { queued: 3 } });
		expect((await get<StatusResponse>("/api/status")).summaryJob).toEqual({ done: expect.any(Number), total: 3 });
		expect((await post("/api/summaries/run", { since: since() })).status).toBe(409);
		await waitForSummaryJob();
		expect((await get<StatusResponse>("/api/status")).summaryJob).toBeNull();
		expect(fake.invocations()).toHaveLength(3);
		expect((await get<StatusResponse>("/api/status")).pendingImportedSummaries).toBe(1); // the 40-day-old one
	}, 60_000);

	it("stops at the daily cap", async () => {
		setConfigValue("ai.maxPerDay", "1");
		await post("/api/summaries/run", { since: since() });
		await waitForSummaryJob();
		expect(fake.invocations()).toHaveLength(1);
	});

	it("stops after 3 errors in a row", async () => {
		for (let i = 3; i < 6; i++) seed(`imp${i}`, { capture: "backfill", startedAgo: (10 - i) * HOUR });
		fake.scenario({ exitCode: 1 });
		await post("/api/summaries/run", { since: since() });
		await waitForSummaryJob();
		expect(fake.invocations()).toHaveLength(6); // 3 sessions x (1 try + 1 retry)
	}, 60_000);

	it("rejects a bad body", async () => {
		expect((await post("/api/summaries/run", { since: "x" })).status).toBe(422);
	});
});

describe("GET /api/status", () => {
	it("counts pending summaries by capture and reports the real ai settings", async () => {
		seed("hooked");
		seed("imp", { capture: "backfill" });
		setConfigValue("ai.review.enabled", "true");
		const s = await get<StatusResponse>("/api/status");
		expect(s.pendingSummaries).toBe(1);
		expect(s.pendingImportedSummaries).toBe(1);
		expect(s.ai.reviews).toBe(true);
		expect(s.summaryJob).toBeNull();
	});
});

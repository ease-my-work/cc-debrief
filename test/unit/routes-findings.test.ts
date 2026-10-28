import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Finding } from "../../src/coach/types";
import { setConfigValue } from "../../src/config";
import type { Db } from "../../src/db/adapter";
import { upsertFindings } from "../../src/db/queries/findings";
import { getMeta } from "../../src/db/queries/meta";
import { createApp } from "../../src/server/app";
import type {
	ConfigResponse,
	DismissResponse,
	FeedbackResponse,
	FindingsResponse,
	ImprovementsResponse,
	SessionDetail,
} from "../../src/server/types";
import { seedDb } from "../helpers/seed";
import { type TmpHome, tmpHome } from "../helpers/tmp-home";

const HOST = { host: "127.0.0.1:4242" };
const JSON_HEADERS = { ...HOST, "content-type": "application/json" };
let h: TmpHome;
let db: Db;
beforeEach(() => {
	h = tmpHome();
	db = seedDb();
	db.prepare("INSERT INTO repos (repo_id, root_path, name) VALUES ('ra', '/a', 'a')").run();
});
afterEach(() => {
	db.close();
	h.cleanup();
});

const app = () => createApp(db, { port: 4242, uiDir: "/x" });
const get = async <T>(path: string) => {
	const r = await app().request(path, { headers: HOST });
	return { status: r.status, body: (await r.json()) as T };
};
const post = async <T>(path: string, body?: unknown, headers: Record<string, string> = JSON_HEADERS) => {
	const r = await app().request(path, {
		method: "POST",
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	return { status: r.status, body: (await r.json()) as T };
};

const ago = (h: number) => new Date(Date.now() - h * 3_600_000);
const finding = (rule: string, key: string, o: Partial<Finding> = {}): Finding => ({
	rule,
	severity: "medium",
	message: `${rule} ${key}`,
	evidence: { key, turns: [2, 5], count: 3 },
	costTokens: 100,
	target: "session",
	...o,
});

/** A hooks session in repo ra with two findings. */
function seedSession(id: string, o: { capture?: "hooks" | "backfill" } = {}) {
	db.prepare("INSERT INTO sessions (session_id, repo_id, started_at, ended_at, capture) VALUES (?, 'ra', ?, ?, ?)").run(
		id,
		ago(3).toISOString(),
		ago(2).toISOString(),
		o.capture ?? "hooks",
	);
	upsertFindings(
		db,
		id,
		["retry_loop", "context_churn"],
		[
			finding("retry_loop", "npm test"),
			finding("context_churn", "f", { severity: "low", costTokens: 40, evidence: { key: "f", turns: [3] } }),
		],
		ago(1),
	);
	return db
		.prepare("SELECT id FROM findings WHERE session_id = ? ORDER BY rule")
		.all<{ id: number }>(id)
		.map((r) => r.id); // [context_churn, retry_loop]
}

describe("GET /api/findings", () => {
	it("lists FindingRow objects, filtered by session", async () => {
		seedSession("s1");
		seedSession("s2");
		const all = await get<FindingsResponse>("/api/findings?range=7d");
		expect(all.status).toBe(200);
		expect(all.body.findings).toHaveLength(4);
		const one = await get<FindingsResponse>("/api/findings?session=s1");
		expect(one.body.findings.map((f) => [f.sessionId, f.rule, f.label])).toEqual(
			expect.arrayContaining([
				["s1", "retry_loop", "retry loop"],
				["s1", "context_churn", "context churn"],
			]),
		);
		expect(one.body.findings).toHaveLength(2);
		expect(one.body.findings[0]).toEqual(
			expect.objectContaining({ repoId: "ra", demoted: false, dismissedUntil: null, feedback: null }),
		);
	});

	it("rejects a bad range with 400", async () => {
		expect((await get("/api/findings?range=1y")).status).toBe(400);
	});
});

describe("POST /api/findings/:id/feedback", () => {
	it("records the vote and returns the demoted flag", async () => {
		const [, loop] = seedSession("s1");
		const r = await post<FeedbackResponse>(`/api/findings/${loop}/feedback`, { value: "not_helpful" });
		expect(r).toEqual({ status: 200, body: { ok: true, demoted: false } });
		expect(db.prepare("SELECT feedback FROM findings WHERE id = ?").get(loop)).toEqual({ feedback: "not_helpful" });
	});

	it("is 400 for a bad value and 404 for an unknown finding", async () => {
		const [, loop] = seedSession("s1");
		expect((await post(`/api/findings/${loop}/feedback`, { value: "meh" })).status).toBe(400);
		expect((await post(`/api/findings/${loop}/feedback`, {})).status).toBe(400);
		expect((await post("/api/findings/999/feedback", { value: "helpful" })).status).toBe(404);
		expect((await post("/api/findings/abc/feedback", { value: "helpful" })).status).toBe(404);
	});
});

describe("POST /api/findings/:id/dismiss", () => {
	it("dismisses the group for 30 days and returns dismissedUntil", async () => {
		const [, loop] = seedSession("s1");
		const r = await post<DismissResponse>(`/api/findings/${loop}/dismiss`, {});
		expect(r.status).toBe(200);
		expect(r.body.ok).toBe(true);
		expect(Date.parse(r.body.dismissedUntil) - Date.now()).toBeGreaterThan(29 * 86_400_000);
		expect(db.prepare("SELECT dismissed_until FROM findings WHERE id = ?").get(loop)).toEqual({
			dismissed_until: r.body.dismissedUntil,
		});
	});

	it("with scope session hides all of that session's findings from the band", async () => {
		const [churn] = seedSession("s1");
		seedSession("s2");
		const r = await post<DismissResponse>(`/api/findings/${churn}/dismiss`, { scope: "session" });
		expect(r.status).toBe(200);
		const band = (await get<SessionDetail>("/api/sessions/s1")).body.review;
		expect(band?.findings).toEqual([]);
		expect(band?.dismissedUntil).toBe(r.body.dismissedUntil);
		expect((await get<SessionDetail>("/api/sessions/s2")).body.review?.findings).toHaveLength(2);
	});

	it("writes the meta key for a digest-rule finding", async () => {
		upsertFindings(db, null, ["unused_skill"], [finding("unused_skill", "7", { target: "skills" })], ago(1));
		const id = db.prepare("SELECT id FROM findings WHERE rule = 'unused_skill'").get<{ id: number }>()?.id;
		const r = await post<DismissResponse>(`/api/findings/${id}/dismiss`, {});
		expect(getMeta(db, "dismiss:unused_skill:7")).toBe(r.body.dismissedUntil);
	});

	it("is 404 for an unknown finding and 400 for a bad scope", async () => {
		const [churn] = seedSession("s1");
		expect((await post("/api/findings/999/dismiss", {})).status).toBe(404);
		expect((await post(`/api/findings/${churn}/dismiss`, { scope: "all" })).status).toBe(400);
	});
});

describe("POST /api/findings/rules/:rule/enable and GET /api/config demotedRules", () => {
	it("lists a demoted rule and re-enables it", async () => {
		db.prepare(
			"INSERT INTO rule_feedback (rule, helpful, not_helpful, demoted, updated_at) VALUES ('retry_loop', 0, 3, 1, '2026-10-01T00:00:00.000Z')",
		).run();
		expect((await get<ConfigResponse>("/api/config")).body.demotedRules).toEqual([
			{ rule: "retry_loop", notHelpful: 3, demotedAt: "2026-10-01T00:00:00.000Z" },
		]);
		expect(await post("/api/findings/rules/retry_loop/enable")).toEqual({ status: 200, body: { ok: true } });
		expect((await get<ConfigResponse>("/api/config")).body.demotedRules).toEqual([]);
	});

	it("is 404 for an unknown rule", async () => {
		expect((await post("/api/findings/rules/nope/enable")).status).toBe(404);
	});
});

describe("write routes reject cross-origin requests", () => {
	it("returns 403 for a foreign Origin or a non-JSON body", async () => {
		const [, loop] = seedSession("s1");
		for (const path of [
			`/api/findings/${loop}/feedback`,
			`/api/findings/${loop}/dismiss`,
			"/api/findings/rules/retry_loop/enable",
		]) {
			expect((await post(path, { value: "helpful" }, { ...JSON_HEADERS, origin: "http://evil.example" })).status).toBe(
				403,
			);
			expect((await post(path, { value: "helpful" }, { ...HOST, "content-type": "text/plain" })).status).toBe(403);
		}
		expect(db.prepare("SELECT feedback, dismissed_until FROM findings WHERE id = ?").get(loop)).toEqual({
			feedback: null,
			dismissed_until: null,
		});
	});
});

describe("GET /api/improvements items", () => {
	it("returns ranked digest items for the range and repo", async () => {
		seedSession("s1");
		seedSession("s2");
		const r = await get<ImprovementsResponse>("/api/improvements?range=7d&repo=ra");
		expect(r.body.items.map((i) => [i.rule, i.costTokens, i.sessionCount])).toEqual([
			["retry_loop", 200, 2],
			["context_churn", 80, 2],
		]);
		expect((await get<ImprovementsResponse>("/api/improvements?repo=other")).body.items).toEqual([]);
	});
});

describe("GET /api/sessions/:id review band", () => {
	it("shows a hooks session's findings and prompts recorded", async () => {
		seedSession("s1");
		const band = (await get<SessionDetail>("/api/sessions/s1")).body.review;
		expect(band).toEqual({
			state: "disabled",
			estUsd: null,
			capReached: false,
			findings: [
				{
					id: expect.any(Number),
					rule: "retry_loop",
					label: "retry loop",
					severity: "medium",
					message: "retry_loop npm test",
					turns: [2, 5],
					costTokens: 100,
					collapsed: false,
					feedback: null,
				},
				{
					id: expect.any(Number),
					rule: "context_churn",
					label: "context churn",
					severity: "low",
					message: "context_churn f",
					turns: [3],
					costTokens: 40,
					collapsed: false,
					feedback: null,
				},
			],
			tier2: null,
			dismissedUntil: null,
			permissionPrompts: "recorded",
			nudgeDismissed: false,
		});
	});

	it("says not_recorded for an imported session, not_reviewed with reviews on, and has no discarded-work state", async () => {
		seedSession("imp", { capture: "backfill" });
		setConfigValue("ai.review.enabled", "true");
		const imp = (await get<SessionDetail>("/api/sessions/imp")).body.review;
		expect(imp).toMatchObject({ state: "not_reviewed", permissionPrompts: "not_recorded" });
		expect(imp).not.toHaveProperty("discardedWork");
	});

	it("reflects the dismissed session nudge", async () => {
		seedSession("s1");
		await post("/api/nudges/session/dismiss");
		expect((await get<SessionDetail>("/api/sessions/s1")).body.review?.nudgeDismissed).toBe(true);
	});
});

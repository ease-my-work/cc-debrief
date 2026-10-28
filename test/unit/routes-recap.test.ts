// Phase 6 Task 9: GET /api/recap and POST /api/recap/polish (feature 17 API). Date is faked to the fixture's 18:00.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigSchema, setConfigValue } from "../../src/config";
import type { Db } from "../../src/db/adapter";
import { buildRecap } from "../../src/recap/build";
import { formatMarkdown, formatRepo, formatText } from "../../src/recap/format";
import { createApp } from "../../src/server/app";
import type { RecapPolishResponse, RecapResponse } from "../../src/server/types";
import { FAKE_RECAP, type FakeClaude, fakeClaude, successResult } from "../helpers/fake-claude";
import { LEAK_DIR, LEAK_TOKEN, RECAP_DAY, RECAP_NOW, seedRecapFixture } from "../helpers/recap-seed";
import { seedDb } from "../helpers/seed";
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
	seedRecapFixture(db);
	fake = fakeClaude(h.home);
	restore = fake.install();
	vi.useFakeTimers({ now: RECAP_NOW, toFake: ["Date"] });
});
afterEach(() => {
	vi.useRealTimers();
	restore();
	db.close();
	h.cleanup();
});

const app = () => createApp(db, { port: 4242, uiDir: "/x" });
const get = async <T>(path: string) => {
	const r = await app().request(path, { headers: HOST });
	return { status: r.status, body: (await r.json()) as T, raw: r };
};
const post = async <T>(path: string, body: unknown, headers: Record<string, string> = JSON_HEADERS, a = app()) => {
	const r = await a.request(path, { method: "POST", headers, body: JSON.stringify(body) });
	return { status: r.status, body: (await r.json()) as T };
};
const DAY = { from: RECAP_DAY, to: RECAP_DAY };
const built = (range = DAY, groupBy: "repo" | "day" = "repo", files = true) =>
	buildRecap(db, ConfigSchema.parse({}), { range, groupBy, files, now: RECAP_NOW });

describe("GET /api/recap", () => {
	it("today by default: recap, text, markdown, repoText and the polish estimate", async () => {
		const r = await get<RecapResponse>("/api/recap");
		expect(r.status).toBe(200);
		const b = built();
		expect(r.body.recap).toEqual(b);
		expect(r.body.text).toBe(formatText(b));
		expect(r.body.markdown).toBe(formatMarkdown(b));
		expect(Object.keys(r.body.repoText)).toEqual(["checkout-flow", "api-gateway", "notes", "scratch", "secret-client"]);
		for (const [repo, v] of Object.entries(r.body.repoText)) {
			expect(v.text).toBe(formatRepo(b, repo, "text"));
			expect(v.markdown).toBe(formatRepo(b, repo, "markdown"));
		}
		expect(r.body.polishEstUsd === null || typeof r.body.polishEstUsd === "number").toBe(true);
		expect(fake.calls()).toEqual([]);
	});

	it("week, by day, files off", async () => {
		const w = await get<RecapResponse>("/api/recap?range=week");
		expect(w.body.recap.range).toEqual({ from: "2026-09-22", to: RECAP_DAY });
		const d = await get<RecapResponse>("/api/recap?range=week&groupBy=day");
		expect(d.body.recap.days.map((x) => x.date)).toEqual(["2026-09-27", RECAP_DAY]);
		expect(d.body.text).toBe(formatText(built({ from: "2026-09-22", to: RECAP_DAY }, "day")));
		expect(Object.keys(d.body.repoText)).toContain("notes");
		const f = await get<RecapResponse>("/api/recap?files=0");
		expect(f.body.text).toBe(formatText(built(DAY, "repo", false)));
		expect(f.body.text).not.toContain("errors.go");
	});

	it("date, from / to and yesterday", async () => {
		expect((await get<RecapResponse>("/api/recap?date=2026-09-27")).body.recap.range).toEqual({
			from: "2026-09-27",
			to: "2026-09-27",
		});
		expect((await get<RecapResponse>("/api/recap?range=yesterday")).body.recap.range.from).toBe("2026-09-27");
		expect((await get<RecapResponse>("/api/recap?from=2026-09-20&to=2026-09-27")).body.recap.range).toEqual({
			from: "2026-09-20",
			to: "2026-09-27",
		});
	});

	it.each([
		["/api/recap?date=2026-02-30", 'invalid date "2026-02-30"'],
		["/api/recap?range=week&date=2026-09-11", "use one of --today, --yesterday, --date, --week, --from"],
		["/api/recap?from=2026-09-10&to=2026-09-01", "from is after to"],
	])("%s → 400 invalid_range", async (path, message) => {
		const r = await get<{ error: { code: string; message: string } }>(path);
		expect(r.status).toBe(400);
		expect(r.body.error).toEqual({ code: "invalid_range", message });
	});

	it("a bad groupBy or files value is a 400", async () => {
		expect((await get("/api/recap?groupBy=week")).status).toBe(400);
		expect((await get("/api/recap?files=yes")).status).toBe(400);
		expect((await get("/api/recap?range=month")).status).toBe(400);
	});

	it("hidden repos are gone from every field", async () => {
		setConfigValue("recap.hiddenRepos", '["secret-client"]');
		const r = await get<RecapResponse>("/api/recap");
		expect(JSON.stringify(r.body)).not.toContain("secret-client");
		expect(JSON.stringify(r.body)).not.toContain("invoice");
		expect(r.body.recap.hiddenRepos).toBe(1);
	});

	it("no prompt text or directory in the response", async () => {
		for (const q of ["", "?range=week&groupBy=day"]) {
			const s = JSON.stringify((await get(`/api/recap${q}`)).body);
			expect(s).not.toContain(LEAK_TOKEN);
			expect(s).not.toContain(LEAK_DIR);
			expect(s).not.toContain("/home/u");
		}
	});
});

describe("POST /api/recap/polish", () => {
	it("polishes once and returns the polished recap with its text and markdown", async () => {
		fake.scenario({ stdout: successResult(FAKE_RECAP) });
		const r = await post<RecapPolishResponse>("/api/recap/polish", {});
		expect(r.status).toBe(200);
		expect(r.body.polished.groups).toEqual(FAKE_RECAP.groups);
		expect(r.body.text).toBe(formatText(r.body.polished));
		expect(r.body.markdown).toBe(formatMarkdown(r.body.polished));
		expect(fake.calls()).toHaveLength(1);
		expect(fake.invocations()[0].stdin).not.toContain(LEAK_TOKEN);
	});

	it("takes the same range inputs as GET", async () => {
		fake.scenario({ stdout: successResult({ groups: [{ repo: "notes", items: ["Fixed the export bug"] }] }) });
		const r = await post<RecapPolishResponse>("/api/recap/polish", { range: "week", groupBy: "day" });
		expect(r.body.polished.range).toEqual({ from: "2026-09-22", to: RECAP_DAY });
		const bad = await post<{ error: { code: string } }>("/api/recap/polish", { date: "nope" });
		expect(bad.status).toBe(400);
		expect(bad.body.error.code).toBe("invalid_range");
	});

	it("a failure is 502 polish_failed with the reason, no retry", async () => {
		fake.scenario({ stdout: successResult({ groups: [{ repo: "made-up", items: ["x"] }] }) });
		const r = await post<{ error: { code: string; reason: string } }>("/api/recap/polish", {});
		expect(r.status).toBe(502);
		expect(r.body.error).toMatchObject({ code: "polish_failed", reason: "schema" });
		expect(fake.calls()).toHaveLength(1);
	});

	it("a second polish while one runs is 409 polish_in_flight", async () => {
		vi.useRealTimers();
		fake.scenario({ stdout: successResult(FAKE_RECAP), delayMs: 1500 });
		const a = app();
		// Real timers: "today" is the real date, so name the fixture day.
		const day = { date: RECAP_DAY };
		const first = post<RecapPolishResponse>("/api/recap/polish", day, JSON_HEADERS, a);
		await vi.waitFor(() => expect(fake.calls()).toHaveLength(1), { timeout: 10_000, interval: 50 });
		const second = await post<{ error: { code: string } }>("/api/recap/polish", day, JSON_HEADERS, a);
		expect(second.status).toBe(409);
		expect(second.body.error.code).toBe("polish_in_flight");
		expect((await first).status).toBe(200);
		fake.scenario({ stdout: successResult(FAKE_RECAP) });
		expect((await post("/api/recap/polish", day, JSON_HEADERS, a)).status).toBe(200);
	});

	it("rejects a cross-origin write like every POST route", async () => {
		const r = await post("/api/recap/polish", {}, { ...JSON_HEADERS, origin: "http://evil.example" });
		expect(r.status).toBe(403);
		expect(fake.calls()).toEqual([]);
	});
});

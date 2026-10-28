// Bulk enrich asks git once per directory (repoInfo) and once per repo root (headSha) per run (Phase 1 carry-over).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepoInfo } from "../../src/collector/git";
import type { Db } from "../../src/db/adapter";
import { writeTranscript } from "../helpers/fixtures";
import { seedDb } from "../helpers/seed";
import { type TmpHome, tmpHome } from "../helpers/tmp-home";

const calls = vi.hoisted(() => ({ repoInfo: [] as string[], headSha: [] as string[] }));
vi.mock("../../src/collector/git", async (importOriginal) => {
	const real = await importOriginal<typeof import("../../src/collector/git")>();
	const info: RepoInfo = {
		root: "/w/app",
		remoteUrl: "https://github.com/me/app.git",
		branch: "main",
		head: "abc",
		name: "app",
	};
	return {
		...real,
		repoInfo: async (cwd: string) => {
			calls.repoInfo.push(cwd);
			return info;
		},
		headSha: async (root: string) => {
			calls.headSha.push(root);
			return "abc";
		},
		headAt: async () => null,
		numstat: async () => [],
	};
});

const { enrichPending, enrichSession } = await import("../../src/enrich");
const { ingestPending } = await import("../../src/ingest/ingest");

let h: TmpHome;
let db: Db;
beforeEach(() => {
	h = tmpHome();
	db = seedDb();
	calls.repoInfo.length = 0;
	calls.headSha.length = 0;
});
afterEach(() => {
	db.close();
	h.cleanup();
});

const ids = [
	"aaaaaaaa-0000-4000-8000-0000000000c1",
	"bbbbbbbb-0000-4000-8000-0000000000c2",
	"cccccccc-0000-4000-8000-0000000000c3",
];
const prompt = (ts: string) => ({
	type: "user",
	uuid: `u-${ts}`,
	timestamp: ts,
	cwd: "/w/app",
	message: { role: "user", content: "x" },
});

/** One transcript per id, an hour apart, all in /w/app. */
function writeAll() {
	ids.forEach((id, i) => {
		writeTranscript(h.claude, "p", id, [prompt(new Date(Date.now() - (i + 1) * 3_600_000).toISOString())]);
	});
}

describe("enrichPending git cache", () => {
	it("looks up repoInfo once per directory and headSha once per root for the whole run", async () => {
		writeAll();
		ingestPending(db);
		expect(await enrichPending(db, { ai: false })).toBe(3);
		expect(calls.repoInfo).toEqual(["/w/app"]);
		expect(calls.headSha).toEqual(["/w/app"]);
		expect(
			db.prepare("SELECT count(*) AS n FROM sessions WHERE head_end = 'abc' AND repo_id IS NOT NULL").get(),
		).toEqual({ n: 3 });
	});

	it("starts a fresh cache for each single-session enrich", async () => {
		writeTranscript(h.claude, "p", ids[0], [prompt(new Date().toISOString())]);
		await enrichSession(db, ids[0], { ai: false });
		await enrichSession(db, ids[0], { ai: false });
		expect(calls.repoInfo).toHaveLength(2);
	});

	it("stops between sessions when the signal is aborted", async () => {
		writeAll();
		ingestPending(db);
		const controller = new AbortController();
		controller.abort();
		expect(await enrichPending(db, { ai: false, signal: controller.signal })).toBe(0);
	});
});

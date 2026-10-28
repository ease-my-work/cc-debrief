import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { repoIdFor, repoInfo } from "../../src/collector/git";
import { setConfigValue } from "../../src/config";
import type { Db } from "../../src/db/adapter";
import { getMeta } from "../../src/db/queries/meta";
import { deriveSession } from "../../src/derive/session";
import { enrichPending, enrichSession, snapshotSession } from "../../src/enrich";
import { coachErrorsLogPath, ensureDir } from "../../src/paths";
import { bundleScript } from "../helpers/bundle";
import { type FakeClaude, fakeClaude, successResult } from "../helpers/fake-claude";
import { FIXTURES, readExpected, writeTranscript } from "../helpers/fixtures";
import { gitRepo, type TestRepo } from "../helpers/git-repo";
import { seedDb } from "../helpers/seed";
import { type SummarySeed, seedSummarizable } from "../helpers/seed-summary";
import { type TmpHome, tmpHome } from "../helpers/tmp-home";

const A = "aaaaaaaa-0000-4000-8000-00000000000a";
const B = "bbbbbbbb-0000-4000-8000-00000000000b";

let h: TmpHome;
let db: Db;
let repo: TestRepo;
const cleanups: (() => void)[] = [];
beforeEach(() => {
	h = tmpHome();
	setConfigValue("retention.days", "0"); // fixture timestamps age; never skip them
	db = seedDb();
	repo = gitRepo();
});
afterEach(() => {
	for (const c of cleanups.splice(0)) c();
	db.close();
	repo.cleanup();
	h.cleanup();
});

type Row = Record<string, unknown>;
const one = (sql: string, ...p: unknown[]) => db.prepare(sql).get<Row>(...p) as Row;
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const prompt = (ts: string, cwd: string, text = "work") => ({
	type: "user",
	uuid: `p-${ts}`,
	timestamp: ts,
	cwd,
	entrypoint: "cli",
	gitBranch: "main",
	message: { role: "user", content: text },
});
const write = (ts: string, id: string, path: string, content: string) => [
	{
		type: "assistant",
		uuid: `a-${id}`,
		timestamp: ts,
		requestId: `r-${id}`,
		message: {
			id: `m-${id}`,
			model: "claude-opus-5-5",
			content: [{ type: "tool_use", id, name: "Write", input: { file_path: path, content } }],
		},
	},
	{
		type: "user",
		uuid: `u-${id}`,
		timestamp: ts,
		message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] },
		toolUseResult: { filePath: path },
	},
];

describe("snapshotSession", () => {
	it("scans the session's repo into the inventory", async () => {
		repo.commit({ ".claude/skills/a/SKILL.md": "---\nname: a\ndescription: repo skill\n---\n" }, ago(60));
		await snapshotSession(db, A, repo.root);
		const repoId = one("SELECT repo_id FROM sessions WHERE session_id = ?", A).repo_id;
		expect(db.prepare("SELECT scope, repo_id, kind, name FROM inventory").all()).toEqual([
			{ scope: "repo", repo_id: repoId, kind: "skill", name: "a" },
		]);
		expect(getMeta(db, `last_scan_repo:${repoId}`)).toEqual(expect.any(String));
	});

	it("records repo, branch and HEAD at session start, then ingests other pending transcripts", async () => {
		const head = repo.commit({ "a.txt": "a\n" }, ago(60));
		repo.git("remote", "add", "origin", "https://github.com/Org/Snap.git");
		writeTranscript(h.claude, "other", B, [prompt(ago(5), repo.root)]);
		await snapshotSession(db, A, repo.root); // A has no transcript yet (VS Code opens a session before any prompt)
		expect(one("SELECT repo_id, branch, head_start, head_start_source FROM sessions WHERE session_id = ?", A)).toEqual({
			repo_id: "github.com/Org/Snap",
			branch: "main",
			head_start: head,
			head_start_source: "snapshot",
		});
		expect(one("SELECT root_path, remote_url, name FROM repos")).toMatchObject({
			remote_url: "https://github.com/Org/Snap.git",
			name: "Snap",
		});
		expect(one("SELECT count(*) AS n FROM sessions WHERE session_id = ?", B).n).toBe(1);
	});

	it("keeps the first head_start when the session is resumed", async () => {
		const first = repo.commit({ "a.txt": "a" }, ago(60));
		await snapshotSession(db, A, repo.root);
		repo.commit({ "a.txt": "b" }, ago(30));
		await snapshotSession(db, A, repo.root);
		expect(one("SELECT head_start FROM sessions WHERE session_id = ?", A).head_start).toBe(first);
	});

	it("records nothing outside git and does not throw", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ccd-plain-"));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		await snapshotSession(db, A, dir);
		expect(one("SELECT repo_id, head_start FROM sessions WHERE session_id = ?", A)).toEqual({
			repo_id: null,
			head_start: null,
		});
	});

	describe("with the session lock held elsewhere", () => {
		let holder: string;
		let scriptHome: TmpHome;
		beforeAll(() => {
			scriptHome = tmpHome();
			ensureDir(scriptHome.home);
			holder = bundleScript(scriptHome.home, 'import "./test/helpers/hold-lock.ts";', "hold-lock.mjs");
		});
		afterAll(() => scriptHome.cleanup());

		it("gives up after 5 s without changes", async () => {
			repo.commit({ "a.txt": "a" }, ago(60));
			const child: ChildProcess = spawn(process.execPath, [holder, A, "6500"], { env: h.env });
			cleanups.push(() => child.kill());
			await new Promise<void>((resolve, reject) => {
				child.stdout?.on("data", (d: Buffer) => d.toString().includes("locked") && resolve());
				child.on("exit", () => reject(new Error("holder exited")));
			});
			const start = Date.now();
			await expect(snapshotSession(db, A, repo.root)).resolves.toBeUndefined();
			expect(Date.now() - start).toBeGreaterThanOrEqual(4900);
			expect(one("SELECT count(*) AS n FROM sessions").n).toBe(0);
		}, 15_000);
	});
});

describe("enrichSession", () => {
	it("reconstructs head_start from the reflog for a backfilled session and sets head_end", async () => {
		const first = repo.commit({ "a.txt": "a\n" }, ago(120));
		const second = repo.commit({ "a.txt": "b\n" }, ago(30)); // committed during the session
		writeTranscript(h.claude, "p", A, [prompt(ago(60), repo.root), prompt(ago(10), repo.root, "more")]);
		await enrichSession(db, A, { ai: false });
		const s = one("SELECT * FROM sessions WHERE session_id = ?", A);
		expect(s).toMatchObject({
			capture: "backfill",
			head_start: first,
			head_start_source: "reflog",
			head_end: second,
			repo_id: repoIdFor((await repoInfo(repo.root)) as NonNullable<Awaited<ReturnType<typeof repoInfo>>>),
		});
		expect(s.head_start).not.toBe(s.head_end);
		expect(s.enriched_at).toEqual(expect.any(String));
	});

	it("replaces a patch-less Write's counts with numstat, and a later derive keeps them", async () => {
		repo.commit({ "notes.md": "a\nb\nc\n" }, ago(120));
		writeFileSync(join(repo.root, "notes.md"), "a\nx\nc\nd\n"); // what the Write did
		writeTranscript(h.claude, "p", A, [
			prompt(ago(60), repo.root),
			...write(ago(59), "w1", join(repo.root, "notes.md"), "a\nx\nc\nd\n"),
		]);
		await enrichSession(db, A, { ai: false });
		const counts = () => one("SELECT path, lines_added, lines_removed FROM file_changes");
		expect(counts()).toEqual({ path: "notes.md", lines_added: 2, lines_removed: 1 });
		deriveSession(db, A);
		expect(counts()).toEqual({ path: "notes.md", lines_added: 2, lines_removed: 1 });
	});

	it("skips numstat for a backfilled session older than 7 days", async () => {
		repo.commit({ "notes.md": "a\nb\nc\n" }, ago(60 * 24 * 10));
		writeFileSync(join(repo.root, "notes.md"), "a\nx\nc\nd\n");
		const old = ago(60 * 24 * 9);
		writeTranscript(h.claude, "p", A, [
			prompt(old, repo.root),
			...write(old, "w1", join(repo.root, "notes.md"), "a\nx\nc\nd\n"),
		]);
		await enrichSession(db, A, { ai: false });
		expect(one("SELECT lines_added, lines_removed FROM file_changes")).toEqual({ lines_added: 4, lines_removed: 0 });
	});

	it("attributes an edit in a second repo to that repo", async () => {
		repo.commit({ "a.txt": "a" }, ago(120));
		const other = gitRepo();
		cleanups.push(() => other.cleanup());
		other.commit({ "b.txt": "b" }, ago(120));
		writeTranscript(h.claude, "p", A, [
			prompt(ago(60), repo.root),
			...write(ago(59), "w1", join(other.root, "src", "x.ts"), "x\n"),
		]);
		await enrichSession(db, A, { ai: false });
		const otherId = repoIdFor((await repoInfo(other.root)) as NonNullable<Awaited<ReturnType<typeof repoInfo>>>);
		expect(one("SELECT repo_id, path FROM file_changes")).toEqual({ repo_id: otherId, path: "src/x.ts" });
		expect(one("SELECT repo_id FROM sessions").repo_id).not.toBe(otherId);
	});

	it("completes outside git with repo_id NULL", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ccd-plain-"));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		writeTranscript(h.claude, "p", A, [prompt(ago(60), dir), ...write(ago(59), "w1", join(dir, "a.md"), "x\n")]);
		await enrichSession(db, A, { ai: false });
		expect(one("SELECT repo_id, head_start, head_end, enriched_at FROM sessions")).toMatchObject({
			repo_id: null,
			head_start: null,
			head_end: null,
			enriched_at: expect.any(String),
		});
	});

	it("enriches the basic fixture in a temp repo within 5 s", async () => {
		repo.commit({ "README.md": "# Basic\n", "src/hello.ts": "cosnt x = 1;\n" }, "2026-08-31T10:00:00.000Z");
		const root = JSON.stringify(repo.root).slice(1, -1); // JSON-escaped for the raw transcript text
		const basic = readExpected("basic");
		const dir = join(FIXTURES, "synthetic", "basic");
		const main = readFileSync(join(dir, `${basic.sessionId}.jsonl`), "utf8").replaceAll("/home/user/basic", root);
		const lines = main
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l));
		writeTranscript(h.claude, "basic", basic.sessionId, lines);
		const start = Date.now();
		await enrichSession(db, basic.sessionId, { ai: false });
		expect(Date.now() - start).toBeLessThan(5000);
		expect(one("SELECT enriched_at, repo_id FROM sessions")).toMatchObject({ enriched_at: expect.any(String) });
		expect(one("SELECT repo_id, path FROM file_changes")).toMatchObject({ path: "src/hello.ts" });
	});
});

describe("enrichPending", () => {
	it("enriches sessions without enriched_at, oldest first, up to the limit", async () => {
		repo.commit({ "a.txt": "a" }, ago(300));
		writeTranscript(h.claude, "p", A, [prompt(ago(200), repo.root)]);
		writeTranscript(h.claude, "p", B, [prompt(ago(100), repo.root)]);
		await snapshotSession(db, "cccccccc-0000-4000-8000-00000000000c", repo.root); // ingests A and B
		expect(await enrichPending(db, { ai: false, limit: 1 })).toBe(1);
		expect(one("SELECT enriched_at FROM sessions WHERE session_id = ?", A).enriched_at).toEqual(expect.any(String));
		expect(one("SELECT enriched_at FROM sessions WHERE session_id = ?", B).enriched_at).toBeNull();
		expect(await enrichPending(db, { ai: false })).toBe(2); // B and the snapshot-only session
		expect(await enrichPending(db, { ai: false })).toBe(0);
	});
});

describe("enrichSession with AI", () => {
	let fake: FakeClaude;
	let restore: () => void;
	beforeEach(() => {
		fake = fakeClaude(h.home);
		restore = fake.install();
	});
	afterEach(() => restore());
	const seed = (id: string, s: SummarySeed = {}) => seedSummarizable(db, h.claude, id, { file: "gone", ...s });
	const summarized = () =>
		db
			.prepare("SELECT target_session_id AS id FROM self_usage ORDER BY id")
			.all<{ id: string }>()
			.map((r) => r.id);

	it("summarizes its session when ai is on", async () => {
		seed(A);
		const r = await enrichSession(db, A, { ai: true });
		expect(r?.status).toBe("done");
		expect(one("SELECT type_source FROM sessions WHERE session_id = ?", A).type_source).toBe("ai");
	});

	it("makes no claude -p call with ai off", async () => {
		seed(A);
		await enrichSession(db, A, { ai: false });
		expect(fake.invocations()).toEqual([]);
	});

	it("from the hook, catches up 5 more pending hook-captured sessions from the last 7 days, oldest first", async () => {
		seed(A, { startedAgo: 30 * 60_000, lastLineAgo: 10 * 60_000 });
		const pending = Array.from({ length: 7 }, (_, i) => `p${i}`);
		for (const [i, id] of pending.entries()) seed(id, { startedAgo: (20 - i) * 3_600_000 });
		seed("too-old", { startedAgo: 8 * 86_400_000 });
		seed("imported", { capture: "backfill" });
		await enrichSession(db, A, { ai: true, catchUp: true });
		expect(summarized()).toEqual([A, "p0", "p1", "p2", "p3", "p4"]);
	}, 120_000);

	it("summaries off: no spawn for the session or the catch-up", async () => {
		setConfigValue("ai.summaries.enabled", "false");
		seed(A);
		seed("p0");
		await enrichSession(db, A, { ai: true, catchUp: true });
		expect(fake.invocations()).toEqual([]);
	});

	describe("auto-review (feature 08 trigger 2)", () => {
		const REVIEW = JSON.parse(
			readFileSync(join(import.meta.dirname, "../fixtures/headless/review-multigoal.json"), "utf8"),
		);
		const features = () =>
			fake
				.invocations()
				.map((i) => i.env.CC_DEBRIEF_FEATURE)
				.filter((f) => f !== null);
		beforeEach(() => {
			setConfigValue("ai.review.enabled", "true");
			setConfigValue("ai.review.auto", "true");
			fake.scenario([{ stdout: successResult() }, { stdout: successResult(REVIEW) }]);
		});
		const reviews = () => db.prepare("SELECT session_id FROM reviews").all();

		it("reviews a 21-turn hook-captured session after its summary", async () => {
			seed(A, { turns: 21 });
			await enrichSession(db, A, { ai: true });
			expect(features()).toEqual(["summary", "review"]);
			expect(reviews()).toEqual([{ session_id: A }]);
		});

		it("does not review a 20-turn session", async () => {
			seed(A, { turns: 20 });
			await enrichSession(db, A, { ai: true });
			expect(features()).toEqual(["summary"]);
		});

		it("never reviews an imported session", async () => {
			seed(A, { turns: 30, capture: "backfill" });
			await enrichSession(db, A, { ai: true, explicit: true });
			expect(features()).toEqual(["summary"]);
		});

		it("auto off: no review", async () => {
			setConfigValue("ai.review.auto", "false");
			seed(A, { turns: 21 });
			await enrichSession(db, A, { ai: true });
			expect(features()).toEqual(["summary"]);
		});

		it("review cap reached: no review and no spawn for it", async () => {
			setConfigValue("ai.review.maxPerDay", "1");
			db.prepare("INSERT INTO ai_calls (feature, ts) VALUES ('review', ?)").run(new Date().toISOString());
			seed(A, { turns: 21 });
			await enrichSession(db, A, { ai: true });
			expect(features()).toEqual(["summary"]);
		});

		it("a failing review does not fail enrich: enriched_at set, summary kept, the error logged", async () => {
			fake.scenario([{ stdout: successResult() }, { exitCode: 1, stderr: "boom" }]);
			seed(A, { turns: 21 });
			const r = await enrichSession(db, A, { ai: true });
			expect(r?.status).toBe("done");
			const row = one("SELECT enriched_at, type_source FROM sessions WHERE session_id = ?", A);
			expect(row.enriched_at).not.toBeNull();
			expect(row.type_source).toBe("ai");
			expect(reviews()).toEqual([]);
			expect(readFileSync(coachErrorsLogPath(), "utf8")).toMatch(/\treview /);
		});

		it("catch-up sessions are not reviewed", async () => {
			fake.scenario({ stdout: successResult() });
			seed(A, { turns: 2, startedAgo: 30 * 60_000, lastLineAgo: 10 * 60_000 });
			seed("p0", { turns: 21, startedAgo: 5 * 3_600_000 });
			await enrichSession(db, A, { ai: true, catchUp: true });
			expect(features()).toEqual(["summary", "summary"]);
		});
	});

	it("does nothing for an internal session's id", async () => {
		seed(A);
		db.prepare("INSERT INTO ai_calls (feature, session_id, ts) VALUES ('summary', ?, ?)").run(A, ago(1));
		expect(await enrichSession(db, A, { ai: true })).toBeNull();
		expect(fake.invocations()).toEqual([]);
	});
});

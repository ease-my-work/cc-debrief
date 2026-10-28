import { existsSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/adapter";
import { hookErrorsLogPath } from "../../src/paths";
import { type FakeClaude, fakeClaude } from "../helpers/fake-claude";
import { writeTranscript } from "../helpers/fixtures";
import { gitRepo, type TestRepo } from "../helpers/git-repo";
import { runCaptured } from "../helpers/run-cli";
import { seedDb } from "../helpers/seed";
import { seedSummarizable } from "../helpers/seed-summary";
import { type TmpHome, tmpHome } from "../helpers/tmp-home";

const SID = "55555555-5555-4555-8555-555555555555";
const UNKNOWN = "66666666-6666-4666-8666-666666666666";

let h: TmpHome;
let db: Db;
let repo: TestRepo;
let head: string;
beforeEach(() => {
	h = tmpHome();
	db = seedDb();
	repo = gitRepo();
	head = repo.commit({ "README.md": "# app\n" }, "2026-09-29T09:00:00Z");
});
afterEach(() => {
	db.close();
	repo.cleanup();
	h.cleanup();
});

const session = () =>
	db.prepare("SELECT head_start, head_end, enriched_at FROM sessions WHERE session_id = ?").get(SID) as
		| Record<string, string | null>
		| undefined;
const logText = () => (existsSync(hookErrorsLogPath()) ? readFileSync(hookErrorsLogPath(), "utf8") : "");
const transcript = () =>
	writeTranscript(h.claude, "proj", SID, [
		{
			type: "user",
			uuid: "u1",
			timestamp: new Date().toISOString(),
			sessionId: SID,
			cwd: repo.root,
			message: { role: "user", content: "hello" },
		},
	]);

describe("cc-debrief snapshot", () => {
	it("--from-hook records HEAD silently", async () => {
		const r = await runCaptured("snapshot", SID, "--cwd", repo.root, "--from-hook");
		expect(r).toEqual({ code: 0, stdout: "", stderr: "" });
		expect(session()?.head_start).toBe(head);
	});

	it("is hidden from --help", async () => {
		const r = await runCaptured("--help");
		expect(r.stdout).toContain("enrich");
		expect(r.stdout).toContain("ingest");
		expect(r.stdout).not.toContain("snapshot");
	});
});

describe("cc-debrief enrich", () => {
	it("enriches a known session", async () => {
		transcript();
		const r = await runCaptured("enrich", SID);
		expect(r.code).toBe(0);
		expect(r.stdout).toBe(`enriched session ${SID} · summary skipped (< 2 turns)\n`);
		expect(session()?.enriched_at).toEqual(expect.any(String));
		expect(session()?.head_end).toBe(head);
	});

	it("enriches pending sessions without an id", async () => {
		transcript();
		const r = await runCaptured("enrich", "--no-ai", "--limit", "5");
		expect(r.code).toBe(0);
		expect(r.stdout).toBe("enriched 1 session (no AI)\n");
	});

	it("exits 1 for an unknown session id", async () => {
		const r = await runCaptured("enrich", UNKNOWN);
		expect(r.code).toBe(1);
		expect(r.stderr).toBe(`error: unknown session ${UNKNOWN}\n`);
	});

	it("--from-hook exits 0 for an unknown id and logs one line", async () => {
		const r = await runCaptured("enrich", UNKNOWN, "--from-hook");
		expect(r).toEqual({ code: 0, stdout: "", stderr: "" });
		expect(logText()).toMatch(new RegExp(`\\tenrich\\tunknown session ${UNKNOWN}\\n$`));
	});

	it("rejects a bad --limit with exit 2", async () => {
		expect((await runCaptured("enrich", "--limit", "zero")).code).toBe(2);
	});
});

describe("cc-debrief enrich summaries", () => {
	let fake: FakeClaude;
	let restore: () => void;
	beforeEach(() => {
		fake = fakeClaude(h.home);
		restore = fake.install();
		db.prepare("INSERT INTO sessions (session_id, enriched_at) VALUES ('u', 'x')").run();
		db.prepare("INSERT INTO usage (session_id, model) VALUES ('u', 'claude-haiku-4-5')").run();
		seedSummarizable(db, h.claude, "hooked", { file: "gone" });
		seedSummarizable(db, h.claude, "imported-1", { file: "gone", capture: "backfill" });
		seedSummarizable(db, h.claude, "imported-2", { file: "gone", capture: "backfill" });
		db.prepare("UPDATE sessions SET enriched_at = 'x'").run();
	});
	afterEach(() => restore());
	const targets = () =>
		db
			.prepare("SELECT target_session_id AS id FROM self_usage ORDER BY target_session_id")
			.all<{ id: string }>()
			.map((r) => r.id);

	it("without --since summarizes pending hook-captured sessions only", async () => {
		const r = await runCaptured("enrich");
		expect(r.code).toBe(0);
		expect(r.stdout).toBe("enriched 0 sessions (1 summary, 0 skipped) · 0 errors\n");
		expect(targets()).toEqual(["hooked"]);
	});

	it("--ai --since prints the estimate, then summarizes imported sessions too", async () => {
		const r = await runCaptured("enrich", "--ai", "--since", "2020-01-01");
		expect(r.code).toBe(0);
		const lines = r.stdout.trim().split("\n");
		expect(lines[0]).toBe("3 sessions · est. ~$0.03 · 50 left in today's cap");
		expect(lines[1]).toBe("enriched 0 sessions (3 summaries, 0 skipped) · 0 errors");
		expect(targets()).toEqual(["hooked", "imported-1", "imported-2"]);
	}, 60_000);

	it("stops at the daily cap", async () => {
		await runCaptured("config", "set", "ai.maxPerDay", "1");
		const r = await runCaptured("enrich", "--ai", "--since", "2020-01-01");
		expect(r.stdout.trim().split("\n")[1]).toBe(
			"enriched 0 sessions (1 summary, 0 skipped, daily cap reached) · 0 errors",
		);
		expect(fake.invocations()).toHaveLength(1);
	});

	it("--no-ai makes no claude -p call", async () => {
		const r = await runCaptured("enrich", "--no-ai");
		expect(r.stdout).toBe("enriched 0 sessions (no AI)\n");
		expect(fake.invocations()).toEqual([]);
	});
});

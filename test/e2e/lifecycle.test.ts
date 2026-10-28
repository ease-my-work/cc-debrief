// The whole Phase 1 loop with the built bundles: install from a throwaway package dir (as npx does), delete it,
// then drive the copied hook.js through a session and check every worker's effect. Skipped without dist/ unless
// REQUIRE_DIST=1.
import { spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HOOK_MARKER } from "../../src/claude/settings";
import { openDb } from "../../src/db/adapter";
import { binDir, claudeSettingsPath, hookErrorsLogPath } from "../../src/paths";
import { type FakeClaude, fakeClaude } from "../helpers/fake-claude";
import { writeTranscript } from "../helpers/fixtures";
import { gitRepo, type TestRepo } from "../helpers/git-repo";
import { type TmpHome, tmpHome } from "../helpers/tmp-home";

const dist = resolve(import.meta.dirname, "../../dist");
const suite = process.env.REQUIRE_DIST === "1" || existsSync(join(dist, "cli.js")) ? describe : describe.skip;

const SID = "77777777-7777-4777-8777-777777777777";
const REPLY = "Fixed the typo in README.md.";
const ORIGINAL = '{\n\t"theme": "dark"\n}\n';

let h: TmpHome;
let repo: TestRepo;
let fake: FakeClaude;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
	h = tmpHome();
	repo = gitRepo();
	fake = fakeClaude(join(h.claude, ".."));
	env = fake.env(h.env);
});
afterEach(() => {
	repo.cleanup();
	h.cleanup();
});

const node = (args: string[], input?: string) =>
	spawnSync(process.execPath, args, { env, input, encoding: "utf8", timeout: 60_000 });

function query<T>(sql: string, ...params: unknown[]): T | undefined {
	const db = openDb();
	try {
		return db.prepare(sql).get<T>(...params);
	} finally {
		db.close();
	}
}

async function waitUntil(what: string, check: () => boolean, ms = 10_000): Promise<void> {
	const until = Date.now() + ms;
	while (Date.now() < until) {
		if (check()) return;
		await new Promise((r) => setTimeout(r, 100));
	}
	const log = existsSync(hookErrorsLogPath()) ? readFileSync(hookErrorsLogPath(), "utf8") : "(no hook-errors.log)";
	throw new Error(`timed out waiting for ${what}; hook-errors.log: ${log}`);
}

const line = (type: "user" | "assistant", uuid: string, text: string) => ({
	type,
	uuid,
	timestamp: new Date().toISOString(),
	sessionId: SID,
	cwd: repo.root,
	entrypoint: "cli",
	message:
		type === "user"
			? { role: "user", content: text }
			: {
					id: `msg-${uuid}`,
					role: "assistant",
					model: "claude-opus-5-5",
					content: [{ type: "text", text }],
					usage: { input_tokens: 12, output_tokens: 7 },
				},
});

suite("install, capture a session, uninstall", () => {
	it("works end to end from a deleted package dir", async () => {
		const head = repo.commit({ "README.md": "# app\nteh typo\n" }, "2026-09-29T09:00:00Z");
		writeFileSync(claudeSettingsPath(), ORIGINAL);

		const pkg = join(h.claude, "..", "pkg");
		mkdirSync(pkg);
		for (const f of ["cli.js", "hook.js"]) copyFileSync(join(dist, f), join(pkg, f));
		const init = node([join(pkg, "cli.js"), "init"]);
		expect(init.stderr).toBe("");
		expect(init.status).toBe(0);
		expect(init.stdout).toMatch(/added +4 hooks/);
		rmSync(pkg, { recursive: true, force: true });

		const hookJs = join(binDir(), "hook.js");
		const settingsText = readFileSync(claudeSettingsPath(), "utf8");
		expect(settingsText).toContain(JSON.stringify(`node "${hookJs}" ${HOOK_MARKER}`).slice(1, -1));
		const hook = (payload: object) => {
			const r = node([hookJs], JSON.stringify({ session_id: SID, cwd: repo.root, ...payload }));
			expect(r.status).toBe(0);
			expect(r.stdout).toBe("");
		};

		const transcriptPath = writeTranscript(h.claude, "app", SID, [line("user", "u1", "fix the typo")]);
		hook({ hook_event_name: "SessionStart", source: "startup", transcript_path: transcriptPath });
		await waitUntil("SessionStart row and head_start", () => {
			const s = query<{ head_start: string | null }>("SELECT head_start FROM sessions WHERE session_id = ?", SID);
			const e = query<{ n: number }>("SELECT count(*) AS n FROM events WHERE event = 'SessionStart'");
			return s?.head_start === head && e?.n === 1;
		});

		appendFileSync(transcriptPath, `${JSON.stringify(line("assistant", "a1", REPLY))}\n`);
		hook({ hook_event_name: "Stop", transcript_path: transcriptPath, last_assistant_message: REPLY });
		await waitUntil(
			"the Stop ingest",
			() => query<{ n: number }>("SELECT count(*) AS n FROM transcript_lines WHERE session_id = ?", SID)?.n === 2,
		);

		hook({ hook_event_name: "SessionEnd", reason: "prompt_input_exit", transcript_path: transcriptPath });
		await waitUntil(
			"enriched_at",
			() => query<{ e: string | null }>("SELECT enriched_at AS e FROM sessions WHERE session_id = ?", SID)?.e != null,
		);
		const s = query<Record<string, unknown>>("SELECT head_end, repo_id FROM sessions WHERE session_id = ?", SID);
		expect(s?.head_end).toBe(head);
		expect(s?.repo_id).toEqual(expect.any(String));

		const doctor = node([join(binDir(), "cli.js"), "doctor"]);
		expect(doctor.stderr).toBe("");
		expect(doctor.stdout).toMatch(/^PASS {2}4\/4 hook entries in /m);
		expect(doctor.stdout).toMatch(/^PASS {2}claude 2\.4\.1 on PATH$/m);
		expect(doctor.stdout).not.toMatch(/^FAIL/m); // the timed hook run may WARN on a slow machine
		expect(doctor.status).toBe(0);
		expect(doctor.stdout).toMatch(/^PASS {2}Claude Code transcripts \(~\/\.claude\/projects\): /m); // Phase 7

		// Phase 7 P15: the terminal digest, from the installed copy, with no AI call.
		const digest = node([join(binDir(), "cli.js"), "digest", "--no-ingest"]);
		expect(digest.stderr).toBe("");
		expect(digest.status).toBe(0);
		expect(digest.stdout.split("\n")[0]).toMatch(/^Claude Code digest · last 7 days \(since \d{4}-\d\d-\d\d\)$/);
		const json = node([join(binDir(), "cli.js"), "digest", "--no-ingest", "--days", "30", "--format", "json"]);
		expect(json.status).toBe(0);
		expect(JSON.parse(json.stdout)).toMatchObject({ days: 30, sessions: 1 });
		expect(node([join(binDir(), "cli.js"), "digest", "--days", "14"]).status).toBe(2);

		const uninit = node([join(binDir(), "cli.js"), "uninit"]);
		expect(uninit.status).toBe(0);
		expect(uninit.stdout).toContain("restored original bytes");
		expect(readFileSync(claudeSettingsPath(), "utf8")).toBe(ORIGINAL);
		expect(existsSync(binDir())).toBe(false);

		const log = existsSync(hookErrorsLogPath()) ? readFileSync(hookErrorsLogPath(), "utf8") : "";
		expect(log).toBe("");
		expect(fake.calls()).toEqual([["--version"]]); // doctor's lookup; no claude -p in Phase 1
	}, 90_000);
});

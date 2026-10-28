import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rebuild } from "../../src/commands/rebuild";
import { setConfigValue } from "../../src/config";
import type { Db } from "../../src/db/adapter";
import { ingestPending } from "../../src/ingest/ingest";
import { decodePayload, encodePayload } from "../../src/ingest/line";
import { type FakeClaude, fakeClaude } from "../helpers/fake-claude";
import { copyFixtureInto, loadFixtureCases } from "../helpers/fixtures";
import { runCaptured } from "../helpers/run-cli";
import { seedDb } from "../helpers/seed";
import { type TmpHome, tmpHome } from "../helpers/tmp-home";

let h: TmpHome;
let db: Db;
let fake: FakeClaude;
let restore: () => void;
let ids: string[];
beforeEach(() => {
	h = tmpHome();
	setConfigValue("retention.days", "0"); // fixture timestamps age; never skip them
	db = seedDb();
	fake = fakeClaude(h.home);
	restore = fake.install();
	for (const c of loadFixtureCases()) copyFixtureInto(h.claude, c.caseDir);
	ids = ingestPending(db).sessions.sort();
});
afterEach(() => {
	restore();
	db.close();
	h.cleanup();
});

// Derived rows without autoincrement ids, so a rebuild can be compared with the original.
const DUMPS: Record<string, string> = {
	sessions: `SELECT session_id, started_at, ended_at, surface, entrypoint, cc_version, capture, models, title, agent_name,
	             summary, session_type, type_source, outcome, tags, summary_error, head_start, head_end, enriched_at,
	             reported_cost_usd FROM sessions ORDER BY session_id`,
	turns:
		"SELECT session_id, seq, prompt_id, user_text, assistant_text, started_at, ended_at FROM turns ORDER BY session_id, seq",
	usage: `SELECT session_id, agent_id, message_id, request_id, model, input_tokens, output_tokens, cache_creation_tokens,
	          cache_read_tokens, cost_usd, ts FROM usage ORDER BY session_id, message_id, request_id`,
	tool_calls: `SELECT session_id, agent_id, tool_use_id, tool_name, mcp_server, skill_name, ok, denied, exit_code, started_at
	               FROM tool_calls ORDER BY session_id, tool_use_id`,
	file_changes:
		"SELECT session_id, path, lines_added, lines_removed, approx FROM file_changes ORDER BY session_id, path, lines_added",
	subagents: "SELECT * FROM subagents ORDER BY session_id, agent_id",
	compactions: "SELECT session_id, ts, trigger, pre_tokens, post_tokens FROM compactions ORDER BY session_id, ts",
	instructions_loaded: "SELECT session_id, file_path, kind FROM instructions_loaded ORDER BY session_id, file_path, ts",
};
const dump = () => Object.fromEntries(Object.entries(DUMPS).map(([t, sql]) => [t, db.prepare(sql).all()]));
const dropDerived = () => {
	for (const t of ["turns", "usage", "tool_calls", "file_changes", "subagents", "compactions", "instructions_loaded"]) {
		db.exec(`DELETE FROM ${t}`);
	}
};

describe("rebuild", () => {
	it("reproduces the derived tables and keeps summaries and head_start", () => {
		db.prepare(
			"UPDATE sessions SET summary = 'Kept.', type_source = 'ai', session_type = 'feature', head_start = 'abc123' WHERE session_id = ?",
		).run(ids[0]);
		const before = dump();
		expect(before.turns.length).toBeGreaterThan(10);
		dropDerived();
		const r = rebuild(db, { reingest: false });
		expect(dump()).toEqual(before);
		expect(r.sessions).toBe(ids.length);
		expect(r.lines).toBe((db.prepare("SELECT count(*) AS n FROM transcript_lines").get() as { n: number }).n);
		expect(r.missingFiles).toBe(0);
		expect(fake.invocations()).toEqual([]);
	});

	it("rebuilds a session whose transcript file is gone from its stored lines", () => {
		const before = dump();
		const main = db
			.prepare("SELECT path FROM transcripts WHERE session_id = ? AND agent_id IS NULL")
			.get<{ path: string }>(ids[0]) as { path: string };
		rmSync(main.path);
		dropDerived();
		const r = rebuild(db, { reingest: false });
		expect(r.missingFiles).toBe(1);
		expect(dump()).toEqual(before);
	});

	it("--reingest restores lines from files on disk and keeps stored lines for files that are gone", () => {
		const lineOf = (sessionId: string) =>
			db
				.prepare(
					`SELECT l.id, l.payload, l.file_id FROM transcript_lines l JOIN transcripts t ON t.id = l.file_id
					 WHERE l.session_id = ? AND t.agent_id IS NULL AND l.type = 'user' ORDER BY l.line_no LIMIT 1`,
				)
				.get<{ id: number; payload: Uint8Array; file_id: number }>(sessionId) as {
				id: number;
				payload: Uint8Array;
				file_id: number;
			};
		const [present, gone] = ids;
		const original = decodePayload(lineOf(present).payload);
		// Simulate lines stored by an older slimLine(): both edited in place.
		for (const id of [present, gone]) {
			const l = lineOf(id);
			db.prepare("UPDATE transcript_lines SET payload = ? WHERE id = ?").run(encodePayload({ edited: true }), l.id);
		}
		const goneFile = db
			.prepare("SELECT path FROM transcripts WHERE session_id = ? AND agent_id IS NULL")
			.get<{ path: string }>(gone) as { path: string };
		rmSync(goneFile.path);

		rebuild(db, { reingest: true });
		expect(decodePayload(lineOf(present).payload)).toEqual(original);
		expect(decodePayload(lineOf(gone).payload)).toEqual({ edited: true });
		expect(fake.invocations()).toEqual([]);
	});
});

describe("cc-debrief rebuild", () => {
	it("prints feature 13's result line", async () => {
		const r = await runCaptured("rebuild");
		expect(r.code).toBe(0);
		expect(r.stdout).toMatch(/^rebuilt \d+ sessions from [\d,]+ transcript lines and \d+ hook events\n$/);
	});
});

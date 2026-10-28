// The append path of deriveSession() must give exactly the rows a full rebuild gives. Each case's transcripts are
// written in chunks (split at uneven points, so turns, tool_use / tool_result pairs and subagent files are cut
// mid-way) and ingested after each chunk; then every session is re-derived in full and all derived rows compared.
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setConfigValue } from "../../src/config";
import type { Db } from "../../src/db/adapter";
import { getMeta, setMeta } from "../../src/db/queries/meta";
import { deriveSession } from "../../src/derive/session";
import { deriveSessions, ingestPending } from "../../src/ingest/ingest";
import { decodePayload } from "../../src/ingest/line";
import { FIXTURES, phase0Cases } from "../helpers/fixtures";
import { genLines, genSessionId } from "../helpers/gen-transcript";
import { seedDb } from "../helpers/seed";
import { type TmpHome, tmpHome } from "../helpers/tmp-home";

let h: TmpHome;
let db: Db;
beforeEach(() => {
	h = tmpHome();
	setConfigValue("retention.days", "0");
	db = seedDb();
});
afterEach(() => {
	db.close();
	h.cleanup();
});

type Row = Record<string, unknown>;
const all = (sql: string) => db.prepare(sql).all<Row>();
const decode = (b: unknown) => (b instanceof Uint8Array ? decodePayload(b) : b);

function snapshot(): Row {
	const seq = new Map(all("SELECT id, seq FROM turns").map((r) => [r.id, r.seq]));
	const toolUse = new Map(all("SELECT id, tool_use_id FROM tool_calls").map((r) => [r.id, r.tool_use_id]));
	const strip = (rows: Row[], fn: (r: Row) => Row = (r) => r) =>
		rows.map((r) => {
			const { id: _id, ...rest } = fn(r);
			return rest;
		});
	return {
		sessions: all("SELECT * FROM sessions ORDER BY session_id"),
		turns: strip(all("SELECT * FROM turns ORDER BY session_id, seq")),
		usage: strip(all("SELECT * FROM usage ORDER BY message_id, request_id, session_id"), (r) => ({
			...r,
			turn_id: seq.get(r.turn_id) ?? null,
		})),
		tool_calls: strip(all("SELECT * FROM tool_calls ORDER BY session_id, tool_use_id"), (r) => ({
			...r,
			turn_id: seq.get(r.turn_id) ?? null,
			input: decode(r.input),
			response: decode(r.response),
		})),
		file_changes: strip(all("SELECT * FROM file_changes"), (r) => ({
			...r,
			tool_call_id: toolUse.get(r.tool_call_id),
		})).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
		subagents: strip(all("SELECT * FROM subagents ORDER BY session_id, agent_id")),
		compactions: strip(all("SELECT * FROM compactions ORDER BY session_id, ts, id")),
		instructions: strip(all("SELECT * FROM instructions_loaded ORDER BY session_id, ts, id")),
	};
}

const walk = (dir: string, out: string[] = []): string[] => {
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) walk(p, out);
		else if (p.endsWith(".jsonl") || p.endsWith(".meta.json")) out.push(p);
	}
	return out;
};

/** Writes each file's lines in `cuts` chunks (fractions of its length), ingesting after each. */
function ingestInChunks(files: { dest: string; lines: string[] }[], cuts: number[]) {
	for (const cut of cuts) {
		for (const f of files) {
			mkdirSync(dirname(f.dest), { recursive: true });
			const n = Math.ceil(f.lines.length * cut);
			writeFileSync(
				f.dest,
				f.lines
					.slice(0, n)
					.map((l) => `${l}\n`)
					.join(""),
			);
		}
		ingestPending(db);
	}
}

function fullRebuild() {
	const ids = all("SELECT session_id FROM sessions").map((r) => r.session_id as string);
	for (const id of ids) deriveSession(db, id, { full: true });
	deriveSessions(db, []); // drain the rederive queue
}

const CUTS = [0.13, 0.37, 0.52, 0.71, 0.9, 1];
const cases = [
	...phase0Cases().map((c) => ({ name: relative(FIXTURES, c.dir), dir: c.dir })),
	{ name: "synthetic/basic", dir: join(FIXTURES, "synthetic", "basic") },
];

describe("incremental derive equals a full rebuild", () => {
	it.each(cases.map((c) => [c.name, c.dir] as const))("%s", (_name, dir) => {
		const files = walk(dir).map((p) => {
			const text = readFileSync(p, "utf8");
			return {
				dest: join(h.claude, "projects", "-case", relative(dir, p)),
				lines: p.endsWith(".jsonl") ? text.split("\n").filter((l) => l.trim() !== "") : [text],
			};
		});
		// .meta.json files are written whole with the first chunk.
		for (const f of files.filter((x) => x.dest.endsWith(".meta.json"))) {
			mkdirSync(dirname(f.dest), { recursive: true });
			writeFileSync(f.dest, f.lines[0]);
		}
		ingestInChunks(
			files.filter((x) => x.dest.endsWith(".jsonl")),
			CUTS,
		);
		const incremental = snapshot();
		fullRebuild();
		expect(incremental).toEqual(snapshot());
	});

	it("a transcript rewritten after ingest (re-read from 0) rebuilds in full", () => {
		const id = genSessionId(8);
		const dest = join(h.claude, "projects", "-gen", `${id}.jsonl`);
		const first = genLines(id, { lines: 400, toolCalls: 20, seed: 1 }).map((l) => JSON.stringify(l));
		ingestInChunks([{ dest, lines: first }], [0.5, 1]);
		const before = (snapshot().turns as unknown[]).length;
		// Same session, different content (a rewind or rewrite): shorter than what was read, so ingest starts over.
		const second = genLines(id, { lines: 150, toolCalls: 9, seed: 2 }).map((l) =>
			JSON.stringify(l).replace(/"uuid":"/, '"uuid":"r'),
		);
		ingestInChunks([{ dest, lines: second }], [1]);
		const after = snapshot();
		fullRebuild();
		expect(after).toEqual(snapshot());
		expect((after.turns as unknown[]).length).toBeLessThan(before);
	});

	it("a subagent file without .meta.json that appears after its parent's result was derived", () => {
		const id = "dddddddd-0000-4000-8000-00000000000d";
		const ts = (s: number) => `2026-09-29T10:00:${String(s).padStart(2, "0")}.000Z`;
		const base = { sessionId: id, cwd: "/w" };
		const main = [
			{ ...base, type: "user", uuid: "u1", timestamp: ts(0), message: { role: "user", content: "explore" } },
			{
				...base,
				type: "assistant",
				uuid: "a1",
				timestamp: ts(1),
				message: {
					id: "m1",
					model: "claude-opus-5-5",
					content: [{ type: "tool_use", id: "toolu_agent", name: "Agent", input: {} }],
				},
			},
			{
				...base,
				type: "user",
				uuid: "r1",
				timestamp: ts(9),
				message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_agent", content: "done" }] },
				toolUseResult: { agentId: "ag1", agentType: "Explore" },
			},
			{ ...base, type: "user", uuid: "u2", timestamp: ts(20), message: { role: "user", content: "next" } },
		].map((l) => JSON.stringify(l));
		const sub = [
			{
				...base,
				type: "assistant",
				uuid: "s1",
				isSidechain: true,
				agentId: "ag1",
				timestamp: ts(30), // written late (a background agent): after turn 2 started
				message: {
					id: "sm1",
					model: "claude-opus-5-5",
					content: [{ type: "tool_use", id: "toolu_sub", name: "Bash", input: { command: "ls" } }],
				},
			},
		].map((l) => JSON.stringify(l));
		const dir = join(h.claude, "projects", "-late");
		ingestInChunks([{ dest: join(dir, `${id}.jsonl`), lines: main }], [1]);
		ingestInChunks([{ dest: join(dir, id, "subagents", "agent-ag1.jsonl"), lines: sub }], [1]);
		const incremental = snapshot();
		fullRebuild();
		expect(incremental).toEqual(snapshot());
		expect((incremental.subagents as Row[])[0]).toMatchObject({ agent_type: "Explore", tool_use_id: "toolu_agent" });
	});

	it("with numstat reconciliation stored: turns without edits stay on the append path, edits to a reconciled file rebuild", () => {
		const id = "eeeeeeee-0000-4000-8000-00000000000e";
		const ts = (s: number) => `2026-09-29T11:00:${String(s).padStart(2, "0")}.000Z`;
		const base = { sessionId: id, cwd: "/w" };
		const prompt = (n: number, uuid: string) =>
			JSON.stringify({
				...base,
				type: "user",
				uuid,
				timestamp: ts(n),
				message: { role: "user", content: `do ${uuid}` },
			});
		const write = (n: number, callId: string, file: string) => [
			JSON.stringify({
				...base,
				type: "assistant",
				uuid: `a${callId}`,
				timestamp: ts(n),
				message: {
					id: `m${callId}`,
					model: "claude-opus-5-5",
					content: [
						{ type: "tool_use", id: callId, name: "Write", input: { file_path: `/w/${file}`, content: "x\ny\n" } },
					],
				},
			}),
			JSON.stringify({
				...base,
				type: "user",
				uuid: `r${callId}`,
				timestamp: ts(n + 1),
				message: { role: "user", content: [{ type: "tool_result", tool_use_id: callId, content: "ok" }] },
				toolUseResult: { type: "create", filePath: `/w/${file}` },
			}),
		];
		db.prepare("INSERT INTO repos (repo_id, root_path, name) VALUES ('local/w', '/w', 'w')").run();
		const dest = join(h.claude, "projects", "-w", `${id}.jsonl`);
		const lines = [prompt(0, "p1"), ...write(1, "w1", "a.txt")];
		ingestInChunks([{ dest, lines }], [1]);
		setMeta(db, `numstat:${id}`, JSON.stringify({ repoId: "local/w", paths: { "a.txt": { added: 7, removed: 0 } } }));
		deriveSession(db, id, { full: true }); // what enrich does after storing numstat
		// Another session's turn above ours, so a full rebuild (delete + insert) gives our turns new ids.
		db.exec(
			"INSERT INTO sessions (session_id) VALUES ('other'); INSERT INTO turns (session_id, seq) VALUES ('other', 1);",
		);
		const firstTurnId = () =>
			(all(`SELECT id FROM turns WHERE session_id = '${id}' ORDER BY seq LIMIT 1`)[0] as Row).id;
		const before = firstTurnId();

		lines.push(prompt(10, "p2"), ...write(11, "w2", "b.txt")); // no edit to a.txt
		ingestInChunks([{ dest, lines }], [1]);
		expect(firstTurnId()).toBe(before); // the append path kept the turn rows
		db.exec("DELETE FROM sessions WHERE session_id = 'other'"); // its turn cascades
		const afterUnrelated = snapshot();
		fullRebuild();
		expect(afterUnrelated).toEqual(snapshot());

		lines.push(prompt(20, "p3"), ...write(21, "w3", "a.txt")); // a reconciled file again
		ingestInChunks([{ dest, lines }], [1]);
		const afterRelated = snapshot();
		fullRebuild();
		expect(afterRelated).toEqual(snapshot());
		expect(
			all("SELECT lines_added FROM file_changes WHERE path = 'a.txt' ORDER BY id").map((r) => r.lines_added),
		).toEqual([2, 7]);
	});

	it("a generated 3,000-line session appended in 25 steps", () => {
		const id = genSessionId(9);
		const lines = genLines(id, { lines: 3000, toolCalls: 120, seed: 4 }).map((l) => JSON.stringify(l));
		const dest = join(h.claude, "projects", "-gen", `${id}.jsonl`);
		ingestInChunks(
			[{ dest, lines }],
			Array.from({ length: 25 }, (_, i) => (i + 1) / 25),
		);
		expect(getMeta(db, `derive:${id}`)).not.toBeNull(); // the append path kept its state
		const incremental = snapshot();
		fullRebuild();
		expect(incremental).toEqual(snapshot());
	});
});

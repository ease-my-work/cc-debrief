import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config";
import type { Db } from "../../src/db/adapter";
import { deriveSession } from "../../src/derive/session";
import { ingestPending } from "../../src/ingest/ingest";
import { decodePayload } from "../../src/ingest/line";
import { copyFixtureInto, FIXTURES, readExpected } from "../helpers/fixtures";
import { seedDb, storeLines } from "../helpers/seed";
import { type TmpHome, tmpHome } from "../helpers/tmp-home";

const basic = readExpected("basic");
const SID = basic.sessionId as string;
const S = "cccccccc-0000-4000-8000-000000000003";

let h: TmpHome;
let db: Db;
beforeEach(() => {
	h = tmpHome();
	db = seedDb();
});
afterEach(() => {
	db.close();
	h.cleanup();
});

type Row = Record<string, unknown>;
const all = (sql: string, ...p: unknown[]) => db.prepare(sql).all<Row>(...p);
const one = (sql: string, ...p: unknown[]) => db.prepare(sql).get<Row>(...p) as Row;

function ingestBasic() {
	copyFixtureInto(h.claude, join(FIXTURES, "synthetic", "basic"));
	ingestPending(db, { config: { ...loadConfig(), retention: { days: 0 } } });
}

const T = (s: string) => `2026-09-01T10:00:${s}.000Z`;
const prompt = (ts: string, text = "do it") => ({
	type: "user",
	uuid: `p${ts}`,
	timestamp: T(ts),
	promptId: `p${ts}`,
	message: { role: "user", content: text },
});
const call = (ts: string, id: string, name: string, input: object, extra: object = {}) => ({
	type: "assistant",
	uuid: `a${ts}${id}`,
	timestamp: T(ts),
	requestId: `r${ts}`,
	message: { id: `m${ts}`, model: "claude-opus-5-5", content: [{ type: "tool_use", id, name, input }] },
	...extra,
});
const result = (ts: string, id: string, content: unknown, toolUseResult: unknown, extra: object = {}) => ({
	type: "user",
	uuid: `r${ts}${id}`,
	timestamp: T(ts),
	message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, ...extra }] },
	toolUseResult,
});

const change = (toolUseId: string) =>
	db
		.prepare(
			`SELECT f.path, f.repo_id, f.lines_added, f.lines_removed, f.language, f.approx
			 FROM file_changes f JOIN tool_calls c ON c.id = f.tool_call_id WHERE c.tool_use_id = ?`,
		)
		.get<Row>(toolUseId);

describe("tool calls on the basic fixture", () => {
	it("writes the rows in basic.expected.json; the slash command adds none", () => {
		ingestBasic();
		const rows = all(
			`SELECT c.tool_use_id, c.tool_name, c.agent_id, t.seq AS turn_seq, c.ok, c.denied, c.exit_code, c.mcp_server,
			        c.mcp_source, c.mcp_tool, c.skill_name, c.started_at, c.ended_at
			 FROM tool_calls c LEFT JOIN turns t ON t.id = c.turn_id WHERE c.session_id = ? ORDER BY c.started_at`,
			SID,
		);
		expect(rows).toEqual(
			basic.toolCalls.map((c: Row) => ({
				tool_use_id: c.toolUseId,
				tool_name: c.toolName,
				agent_id: c.agentId,
				turn_seq: c.turnSeq,
				ok: c.ok,
				denied: c.denied,
				exit_code: c.exitCode,
				mcp_server: c.mcpServer,
				mcp_source: c.mcpSource,
				mcp_tool: c.mcpTool,
				skill_name: c.skillName,
				started_at: c.startedAt,
				ended_at: c.endedAt,
			})),
		);
	});

	it("stores input and response as BLOBs with bytes, isError and a bounded excerpt", () => {
		ingestBasic();
		const bash = one("SELECT input, response FROM tool_calls WHERE tool_use_id = 'toolu_bash'");
		expect(bash.input).toBeInstanceOf(Uint8Array);
		expect(decodePayload(bash.input as Uint8Array)).toEqual({ command: "npm test", description: "Run tests" });
		const response = decodePayload(bash.response as Uint8Array) as Row;
		expect(response).toEqual({
			toolUseResult: "Error: Exit code 1\n> basic@1.0.0 test\n> exit 1",
			bytes: Buffer.byteLength("Exit code 1\n> basic@1.0.0 test\n> exit 1"),
			isError: true,
			excerpt: "Exit code 1\n> basic@1.0.0 test\n> exit 1",
		});
		for (const r of all("SELECT response FROM tool_calls WHERE response IS NOT NULL")) {
			const d = decodePayload(r.response as Uint8Array) as { excerpt: string };
			expect(Buffer.byteLength(d.excerpt)).toBeLessThanOrEqual(4096);
		}
	});

	it("writes the Edit's file change from structuredPatch", () => {
		ingestBasic();
		const [e] = basic.fileChanges;
		expect(change(e.toolUseId)).toEqual({
			path: e.path,
			repo_id: e.repoId,
			lines_added: e.linesAdded,
			lines_removed: e.linesRemoved,
			language: e.language,
			approx: e.approx,
		});
		expect(one("SELECT count(*) AS n FROM file_changes").n).toBe(1); // the denied Write adds none
	});
});

describe("tool call rules", () => {
	it("records origBytes (stored bytes minus each truncation marker plus its N) only for truncated results", () => {
		const cut = `${"x".repeat(8000)}…[truncated 5000 bytes]`;
		const block = `${"y".repeat(100)}…[truncated 7 bytes]`;
		storeLines(db, S, [
			prompt("00"),
			call("01", "t1", "Read", { file_path: "/r/a.ts" }),
			result("02", "t1", cut, { type: "text" }),
			call("03", "t2", "Read", { file_path: "/r/b.ts" }),
			result(
				"04",
				"t2",
				[
					{ type: "text", text: "head" },
					{ type: "text", text: block },
				],
				{ type: "text" },
			),
			call("05", "t3", "Read", { file_path: "/r/c.ts" }),
			result("06", "t3", "short", { type: "text" }),
		]);
		deriveSession(db, S);
		const res = (id: string) =>
			decodePayload(one("SELECT response FROM tool_calls WHERE tool_use_id = ?", id).response as Uint8Array) as Row;
		const marker = (n: number) => Buffer.byteLength(`…[truncated ${n} bytes]`);
		expect(res("t1")).toMatchObject({ bytes: Buffer.byteLength(cut), origBytes: 8000 + 5000 });
		expect(res("t1").bytes).toBe(8000 + marker(5000));
		expect(res("t2").origBytes).toBe(Buffer.byteLength(`head\n${block}`) - marker(7) + 7);
		expect(res("t3")).not.toHaveProperty("origBytes");
	});

	it("keeps only the small toolUseResult fields in response (the full result stays in transcript_lines)", () => {
		const patch = [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-a", "+b"] }];
		const long = "x".repeat(300);
		storeLines(db, S, [
			prompt("00"),
			call("01", "tr", "Read", { file_path: "/r/a.ts" }),
			result("02", "tr", "1\tconst a = 1;", {
				type: "text",
				file: { filePath: "/r/a.ts", content: long, numLines: 1 },
			}),
			call("03", "te", "Edit", { file_path: "/r/a.ts", old_string: "a", new_string: "b" }),
			result("04", "te", "ok", {
				filePath: "/r/a.ts",
				oldString: "a",
				newString: long,
				structuredPatch: patch,
				userModified: false,
				replaceAll: false,
				originalFileLines: 12,
			}),
			call("05", "tb", "Bash", { command: "npm test" }),
			result("06", "tb", "Exit code 1", `Error: Exit code 1\n${"y".repeat(3000)}`, { is_error: true }),
		]);
		deriveSession(db, S);
		const tur = (id: string) =>
			(decodePayload(one("SELECT response FROM tool_calls WHERE tool_use_id = ?", id).response as Uint8Array) as Row)
				.toolUseResult;
		expect(tur("tr")).toEqual({ type: "text" });
		expect(tur("te")).toEqual({
			filePath: "/r/a.ts",
			oldString: "a",
			structuredPatch: patch,
			userModified: false,
			replaceAll: false,
			originalFileLines: 12,
		});
		const bash = tur("tb") as string;
		expect(bash.startsWith("Error: Exit code 1\n")).toBe(true);
		expect(Buffer.byteLength(bash)).toBeLessThanOrEqual(1024);
		expect(bash).toMatch(/…\[truncated \d+ bytes\]$/);
	});

	it("leaves an unpaired call with ok and ended_at NULL", () => {
		storeLines(db, S, [prompt("00"), call("01", "t1", "Bash", { command: "sleep 99" })]);
		deriveSession(db, S);
		expect(one("SELECT ok, ended_at, started_at, response FROM tool_calls")).toEqual({
			ok: null,
			ended_at: null,
			started_at: T("01"),
			response: null,
		});
	});

	it("keeps one row for a tool_use repeated across the lines of a split message", () => {
		const c = call("01", "t1", "Read", { file_path: "/r/a.ts" });
		storeLines(db, S, [prompt("00"), c, { ...c, uuid: "dup", timestamp: T("02") }, result("03", "t1", "x", {})]);
		deriveSession(db, S);
		expect(one("SELECT count(*) AS n, min(started_at) AS s FROM tool_calls")).toEqual({ n: 1, s: T("01") });
	});

	it("ignores a tool_result without a tool_use", () => {
		storeLines(db, S, [prompt("00"), result("01", "orphan", "x", {})]);
		deriveSession(db, S);
		expect(one("SELECT count(*) AS n FROM tool_calls").n).toBe(0);
	});

	it("marks a denied call ok = 0 without an exit code", () => {
		storeLines(db, S, [
			prompt("00"),
			call("01", "t1", "Bash", { command: "rm -rf x" }),
			// Claude Code writes the denial kind at the top level of the result line
			{
				...result("02", "t1", "Exit code 1", "User rejected tool use", { is_error: true }),
				toolDenialKind: "user-rejected",
			},
		]);
		deriveSession(db, S);
		expect(one("SELECT ok, denied, exit_code FROM tool_calls")).toEqual({
			ok: 0,
			denied: "user-rejected",
			exit_code: null,
		});
	});

	it("reads exit codes for PowerShell as for Bash, and not for other tools", () => {
		storeLines(db, S, [
			prompt("00"),
			call("01", "t1", "PowerShell", { command: "npm test" }),
			result("02", "t1", "Exit code 2\nfailed", "Error: Exit code 2", { is_error: true }),
			call("03", "t2", "Read", { file_path: "/r/log" }),
			result("04", "t2", "Exit code 5 appears in this file", {}),
		]);
		deriveSession(db, S);
		expect(all("SELECT tool_name, exit_code FROM tool_calls ORDER BY started_at")).toEqual([
			{ tool_name: "PowerShell", exit_code: 2 },
			{ tool_name: "Read", exit_code: null },
		]);
	});

	it("lets attributionMcpServer / attributionMcpTool override the parsed names", () => {
		storeLines(db, S, [
			prompt("00"),
			call("01", "t1", "mcp__my__srv__tool", {}, { attributionMcpServer: "my__srv", attributionMcpTool: "tool" }),
			result("02", "t1", "ok", {}),
		]);
		deriveSession(db, S);
		expect(one("SELECT mcp_server, mcp_tool, mcp_source FROM tool_calls")).toEqual({
			mcp_server: "my__srv",
			mcp_tool: "tool",
			mcp_source: null,
		});
	});

	it("gives a subagent's calls the turn of the parent Agent call", () => {
		storeLines(db, S, [
			prompt("00", "first"),
			prompt("10", "second"),
			call("11", "toolu_agent", "Agent", { description: "d", subagent_type: "Explore", prompt: "p" }),
			result("30", "toolu_agent", "done", { status: "completed", agentId: "ag1", agentType: "Explore" }),
		]);
		// The subagent's call starts before "second"'s window by timestamp; the parent link must win.
		storeLines(
			db,
			S,
			[
				{ ...call("05", "sub1", "Bash", { command: "ls" }), isSidechain: true, agentId: "ag1" },
				{ ...result("06", "sub1", "a\nb", { stdout: "a\nb" }), agentId: "ag1" },
			],
			"ag1",
		);
		deriveSession(db, S);
		const rows = all(
			"SELECT c.tool_use_id, c.agent_id, t.seq FROM tool_calls c JOIN turns t ON t.id = c.turn_id ORDER BY c.tool_use_id",
		);
		expect(rows).toEqual([
			{ tool_use_id: "sub1", agent_id: "ag1", seq: 2 },
			{ tool_use_id: "toolu_agent", agent_id: null, seq: 2 },
		]);
	});
});

describe("file changes", () => {
	const edit = (id: string, input: object, toolUseResult: object | string, extra: object = {}) => [
		call(`0${id.length}`, id, (input as { tool?: string }).tool ?? "Edit", input),
		result(`1${id.length}`, id, "done", toolUseResult, extra),
	];

	it("counts an Edit without structuredPatch from its input: all old lines removed, all new lines added", () => {
		storeLines(db, S, [
			prompt("00"),
			...edit(
				"e1",
				{ file_path: "/w/a.py", old_string: "a\nb\nc", new_string: "1\n2\n3\n4\n5" },
				{ filePath: "/w/a.py" },
			),
		]);
		deriveSession(db, S);
		expect(change("e1")).toMatchObject({
			lines_added: 5,
			lines_removed: 3,
			language: "py",
			approx: 0,
			path: "/w/a.py",
		});
	});

	it("counts a new Write file as all lines added", () => {
		storeLines(db, S, [
			prompt("00"),
			call("01", "w1", "Write", { file_path: "/w/notes.md", content: "a\nb\nc\nd\n" }),
			result("02", "w1", "created", { type: "create", filePath: "/w/notes.md", structuredPatch: [] }),
		]);
		deriveSession(db, S);
		expect(change("w1")).toMatchObject({ lines_added: 4, lines_removed: 0, language: "md" });
	});

	it("sums MultiEdit edits and counts NotebookEdit's new source", () => {
		storeLines(db, S, [
			prompt("00"),
			call("01", "m1", "MultiEdit", {
				file_path: "/w/b.ts",
				edits: [
					{ old_string: "a", new_string: "b\nc" },
					{ old_string: "d\ne", new_string: "f" },
				],
			}),
			result("02", "m1", "ok", { filePath: "/w/b.ts" }),
			call("03", "n1", "NotebookEdit", { notebook_path: "/w/n.ipynb", new_source: "x = 1\ny = 2" }),
			result("04", "n1", "ok", {}),
		]);
		deriveSession(db, S);
		expect(change("m1")).toMatchObject({ lines_added: 3, lines_removed: 3 });
		expect(change("n1")).toMatchObject({ lines_added: 2, lines_removed: 0, path: "/w/n.ipynb", language: null });
	});

	it("marks counts from truncated text approx", () => {
		storeLines(db, S, [
			prompt("00"),
			call("01", "w1", "Write", { file_path: "/w/big.txt", content: "a\nb…[truncated 900 bytes]" }),
			result("02", "w1", "ok", {}),
		]);
		deriveSession(db, S);
		expect(change("w1")).toMatchObject({ approx: 1 });
	});

	it("writes no change for a failed or denied edit", () => {
		storeLines(db, S, [
			prompt("00"),
			call("01", "f1", "Edit", { file_path: "/w/a", old_string: "x", new_string: "y" }),
			result("02", "f1", "String not found", "Error: String not found", { is_error: true }),
			call("03", "d1", "Write", { file_path: "/w/b", content: "z" }),
			{
				...result("04", "d1", "rejected", "User rejected tool use", { is_error: true }),
				toolDenialKind: "user-rejected",
			},
		]);
		deriveSession(db, S);
		expect(one("SELECT count(*) AS n FROM file_changes").n).toBe(0);
	});

	it("re-applies stored numstat counts to the last Write-only, patch-less row of a path", () => {
		db.exec("INSERT INTO repos (repo_id, root_path, name) VALUES ('r', '/r', 'r')");
		const write = (ts: string, id: string, path: string, content: string, tur: object = { filePath: path }) => [
			call(ts, id, "Write", { file_path: path, content }),
			result(ts, id, "ok", tur),
		];
		storeLines(db, S, [
			prompt("00"),
			...write("01", "w1", "/r/a.md", "1\n2\n"),
			...write("02", "w2", "/r/a.md", "1\n2\n3\n"),
			...write("03", "w3", "/r/b.md", "x\n", {
				filePath: "/r/b.md",
				structuredPatch: [{ lines: ["-y", "+x"] }],
			}),
			call("04", "e1", "Edit", { file_path: "/r/c.md", old_string: "p", new_string: "q" }),
			result("05", "e1", "ok", { filePath: "/r/c.md" }),
			...write("06", "w4", "/r/c.md", "q\n"),
		]);
		db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(
			`numstat:${S}`,
			JSON.stringify({
				repoId: "r",
				paths: {
					"a.md": { added: 2, removed: 7 },
					"b.md": { added: 9, removed: 9 },
					"c.md": { added: 9, removed: 9 },
				},
			}),
		);
		deriveSession(db, S);
		const counts = (id: string) => {
			const c = change(id) as Row;
			return [c.lines_added, c.lines_removed];
		};
		expect(counts("w1")).toEqual([2, 0]); // not the last row for a.md
		expect(counts("w2")).toEqual([2, 7]);
		expect(counts("w3")).toEqual([1, 1]); // has a patch
		expect(counts("w4")).toEqual([1, 0]); // c.md also has an Edit
	});

	it("resolves the repo by the longest root_path prefix and stores paths relative to it", () => {
		db.exec(`INSERT INTO repos (repo_id, root_path, name) VALUES ('outer', '/r', 'r'), ('inner', '/r/sub', 'sub'),
		         ('win', 'C:\\Work\\Repo', 'Repo')`);
		const write = (ts: string, id: string, path: string) => [
			call(ts, id, "Write", { file_path: path, content: "x" }),
			result(ts, id, "ok", { filePath: path }),
		];
		storeLines(db, S, [
			prompt("00"),
			...write("01", "w1", "/r/sub/x.ts"),
			...write("02", "w2", "/r/top.ts"),
			...write("03", "w3", "/rx/y.ts"),
			...write("04", "w4", "/elsewhere/z.ts"),
			...write("05", "w5", "c:\\work\\repo\\src\\a.ts"),
		]);
		deriveSession(db, S);
		expect(change("w1")).toMatchObject({ repo_id: "inner", path: "x.ts" });
		expect(change("w2")).toMatchObject({ repo_id: "outer", path: "top.ts" });
		expect(change("w3")).toMatchObject({ repo_id: null, path: "/rx/y.ts" });
		expect(change("w4")).toMatchObject({ repo_id: null, path: "/elsewhere/z.ts" });
		expect(change("w5")).toMatchObject({ repo_id: "win", path: "src/a.ts" });
	});
});

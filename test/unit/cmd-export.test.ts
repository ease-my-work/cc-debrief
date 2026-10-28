import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exportData } from "../../src/commands/export";
import { setConfigValue } from "../../src/config";
import type { Db } from "../../src/db/adapter";
import { encodePayload } from "../../src/ingest/line";
import { runCaptured } from "../helpers/run-cli";
import { seedDb, storeLines } from "../helpers/seed";
import { type TmpHome, tmpHome } from "../helpers/tmp-home";

const DAY = 86_400_000;
let h: TmpHome;
let db: Db;
let out: string;
beforeEach(() => {
	h = tmpHome();
	db = seedDb();
	out = join(h.claude, "..", "exp");
	const seed = (id: string, age: number, repo: string | null, summary: string) => {
		const ts = new Date(Date.now() - age * DAY).toISOString();
		db.prepare("INSERT INTO sessions (session_id, started_at, repo_id, summary) VALUES (?, ?, ?, ?)").run(
			id,
			ts,
			repo,
			summary,
		);
		db.prepare(
			"INSERT INTO usage (session_id, model, input_tokens, output_tokens, cost_usd, ts) VALUES (?, 'claude-sonnet-4-5', 10, 20, 0.5, ?)",
		).run(id, ts);
		db.prepare("INSERT INTO tool_calls (session_id, tool_name, input, ok) VALUES (?, 'Bash', ?, 1)").run(
			id,
			encodePayload({ command: "echo internal-host-42" }),
		);
		db.prepare(
			"INSERT INTO events (session_id, event, ts, payload) VALUES (?, 'SessionStart', ?, '{\"cwd\":\"/w\"}')",
		).run(id, ts);
		storeLines(db, id, [{ type: "user", uuid: `${id}-u`, timestamp: ts, message: { content: "hello" } }]);
	};
	db.prepare(
		"INSERT INTO repos (repo_id, root_path, name) VALUES ('github.com/example-org/billing-api', '/w/b', 'billing-api')",
	).run();
	seed("s-new", 5, "github.com/example-org/billing-api", 'Fixed "retry", then, a\nnewline');
	seed("s-old", 60, null, "Old work");
});
afterEach(() => {
	db.close();
	h.cleanup();
});

const read = (p: string) => readFileSync(p, "utf8");

describe("exportData", () => {
	it("writes one JSON file with sessions, usage and tool calls", () => {
		const [file] = exportData(db, { format: "json", out });
		expect(file).toBe(`${out}.json`);
		const j = JSON.parse(read(file));
		expect(Object.keys(j).sort()).toEqual(["exportedAt", "sessions", "tool_calls", "usage", "version"]);
		expect(j.sessions.map((s: { session_id: string }) => s.session_id).sort()).toEqual(["s-new", "s-old"]);
		expect(j.usage).toHaveLength(2);
		expect(j.tool_calls[0].input).toEqual({ command: "echo internal-host-42" });
		expect(j.transcript_lines).toBeUndefined();
	});

	it("adds transcript lines and events with includeRaw", () => {
		const [file] = exportData(db, { format: "json", out, includeRaw: true });
		const j = JSON.parse(read(file));
		expect(j.transcript_lines).toHaveLength(2);
		expect(j.transcript_lines[0].payload.message.content).toBe("hello");
		expect(j.events[0].payload).toEqual({ cwd: "/w" });
	});

	it("writes three CSV files with RFC 4180 quoting and a header row", () => {
		const files = exportData(db, { format: "csv", out });
		expect(files).toEqual([`${out}-sessions.csv`, `${out}-usage.csv`, `${out}-tool_calls.csv`]);
		const csv = read(files[0]);
		const [header] = csv.split("\r\n");
		expect(header.split(",")).toContain("session_id");
		expect(header.split(",")).toContain("summary");
		expect(csv).toContain('"Fixed ""retry"", then, a\nnewline"');
		expect(csv.endsWith("\r\n")).toBe(true);
		expect(read(files[2])).toContain('"{""command"":""echo internal-host-42""}"');
	});

	it("filters by --days and --repo", () => {
		const [a] = exportData(db, { format: "json", out: `${out}-a`, days: 30 });
		expect(JSON.parse(read(a)).sessions.map((s: { session_id: string }) => s.session_id)).toEqual(["s-new"]);
		expect(JSON.parse(read(a)).usage).toHaveLength(1);
		const [b] = exportData(db, { format: "json", out: `${out}-b`, repo: "github.com/example-org/billing-api" });
		expect(JSON.parse(read(b)).sessions.map((s: { session_id: string }) => s.session_id)).toEqual(["s-new"]);
	});

	it("refuses to overwrite without force", () => {
		writeFileSync(`${out}-usage.csv`, "keep");
		expect(() => exportData(db, { format: "csv", out })).toThrow(/exists.*--force/);
		expect(read(`${out}-usage.csv`)).toBe("keep");
		expect(existsSync(`${out}-sessions.csv`)).toBe(false);
		exportData(db, { format: "csv", out, force: true });
		expect(read(`${out}-usage.csv`)).not.toBe("keep");
	});

	it("re-runs redaction with the current patterns", () => {
		setConfigValue("capture.redact", JSON.stringify(["@default", "/internal-host-\\d+/g"]));
		const [file] = exportData(db, { format: "json", out });
		const text = read(file);
		expect(text).not.toContain("internal-host-42");
		expect(text).toContain("[REDACTED]");
	});

	it.skipIf(process.platform === "win32")("creates files with mode 0600", () => {
		for (const f of exportData(db, { format: "csv", out })) expect(statSync(f).mode & 0o777).toBe(0o600);
	});
});

describe("cc-debrief export", () => {
	it("prints one line per file and exits 2 on an existing file", async () => {
		const r = await runCaptured("export", "--format", "csv", "--out", out);
		expect(r.code).toBe(0);
		expect(r.stdout.trim().split("\n")).toEqual([
			`wrote ${out}-sessions.csv (2 rows)`,
			`wrote ${out}-usage.csv (2 rows)`,
			`wrote ${out}-tool_calls.csv (2 rows)`,
		]);
		const again = await runCaptured("export", "--format", "csv", "--out", out);
		expect(again.code).toBe(2);
	});

	it("defaults to JSON at ./cc-debrief-export-<YYYYMMDD>", async () => {
		const cwd = process.cwd();
		process.chdir(join(h.claude, ".."));
		try {
			const r = await runCaptured("export");
			expect(r.code).toBe(0);
			expect(r.stdout).toMatch(/^wrote cc-debrief-export-\d{8}\.json \(6 rows\)\n$/);
		} finally {
			process.chdir(cwd);
		}
	});
});

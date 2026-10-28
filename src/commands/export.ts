// `export` (feature 13, spec decision 5): sessions, usage and tool calls as one JSON file or three CSV files, re-run
// through redactDeep() with the current capture.redact list. Raw transcript lines and hook payloads only with
// --include-raw: they are the most sensitive and rarely needed.
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { type Command, InvalidArgumentError, Option } from "commander";
import { type Config, loadConfig } from "../config";
import type { Db } from "../db/adapter";
import { localDate } from "../db/queries/range";
import { decodePayload } from "../ingest/line";
import { redactDeep } from "../redact";
import { VERSION } from "../version";
import { count, type Out, parsePositiveInt, stdout, UsageError, withDb } from "./common";

const DAY_MS = 86_400_000;

export type ExportOptions = {
	format: "json" | "csv";
	out: string;
	days?: number;
	repo?: string;
	force?: boolean;
	includeRaw?: boolean;
	now?: Date;
};

type Row = Record<string, unknown>;

const SESSION_COLUMNS = [
	"session_id",
	"started_at",
	"ended_at",
	"cwd",
	"repo_id",
	"branch",
	"surface",
	"entrypoint",
	"cc_version",
	"capture",
	"start_reason",
	"permission_mode",
	"models",
	"title",
	"agent_name",
	"summary",
	"session_type",
	"type_source",
	"outcome",
	"tags",
	"summary_error",
	"head_start",
	"head_start_source",
	"head_end",
	"reported_cost_usd",
];

function decoded(blob: unknown): unknown {
	if (!(blob instanceof Uint8Array)) return null;
	try {
		return decodePayload(blob);
	} catch {
		return null;
	}
}

function parsedJson(text: unknown): unknown {
	if (typeof text !== "string") return text;
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

function collect(db: Db, opts: ExportOptions): Record<string, Row[]> {
	const now = opts.now ?? new Date();
	const since = opts.days ? new Date(now.getTime() - opts.days * DAY_MS).toISOString() : null;
	// Plain ? only (node:sqlite in Node 22.13 mis-binds numbered parameters): each value is passed twice.
	const where = "(? IS NULL OR started_at >= ?) AND (? IS NULL OR repo_id = ?)";
	const params = [since, since, opts.repo ?? null, opts.repo ?? null];
	const ids = `SELECT session_id FROM sessions WHERE ${where}`;
	const tables: Record<string, Row[]> = {
		sessions: db
			.prepare(`SELECT ${SESSION_COLUMNS.join(", ")} FROM sessions WHERE ${where} ORDER BY started_at, session_id`)
			.all<Row>(...params)
			.map((r) => ({ ...r, models: parsedJson(r.models), tags: parsedJson(r.tags) })),
		usage: db
			.prepare(
				`SELECT session_id, agent_id, turn_id, message_id, request_id, model, input_tokens, output_tokens,
				   cache_creation_tokens, cache_read_tokens, cost_usd, ts
				 FROM usage WHERE session_id IN (${ids}) ORDER BY ts, id`,
			)
			.all<Row>(...params),
		tool_calls: db
			.prepare(
				`SELECT id, session_id, agent_id, turn_id, tool_use_id, tool_name, mcp_server, mcp_source, mcp_tool, skill_name,
				   input, started_at, ended_at, ok, denied, exit_code
				 FROM tool_calls WHERE session_id IN (${ids}) ORDER BY started_at, id`,
			)
			.all<Row>(...params)
			.map((r) => ({ ...r, input: decoded(r.input) })),
	};
	if (opts.includeRaw) {
		tables.transcript_lines = db
			.prepare(
				`SELECT session_id, agent_id, line_no, uuid, parent_uuid, type, subtype, ts, payload
				 FROM transcript_lines WHERE session_id IN (${ids}) ORDER BY session_id, file_id, line_no`,
			)
			.all<Row>(...params)
			.map((r) => ({ ...r, payload: decoded(r.payload) }));
		tables.events = db
			.prepare(`SELECT session_id, event, ts, payload FROM events WHERE session_id IN (${ids}) ORDER BY ts, id`)
			.all<Row>(...params)
			.map((r) => ({ ...r, payload: parsedJson(r.payload) }));
	}
	return tables;
}

/** One CSV field per RFC 4180: quoted when it holds a comma, quote or line break; objects as JSON. */
function csvField(v: unknown): string {
	if (v === null || v === undefined) return "";
	const s = typeof v === "object" ? JSON.stringify(v) : String(v);
	return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export function toCsv(rows: Row[], columns: string[]): string {
	const lines = [columns.map(csvField).join(",")];
	for (const r of rows) lines.push(columns.map((c) => csvField(r[c])).join(","));
	return `${lines.join("\r\n")}\r\n`;
}

function columnsOf(table: string, rows: Row[]): string[] {
	if (table === "sessions") return SESSION_COLUMNS;
	return rows.length > 0 ? Object.keys(rows[0]) : [];
}

function writePrivate(path: string, text: string): void {
	writeFileSync(path, text, { mode: 0o600 });
	if (process.platform !== "win32") chmodSync(path, 0o600); // an overwritten file keeps its old mode otherwise
}

/** Writes the export; returns each file with its row count. Refuses (exit 2) when any target exists, unless force. */
export function exportFiles(db: Db, opts: ExportOptions, cfg: Config = loadConfig()): { path: string; rows: number }[] {
	const tables = collect(db, opts);
	const clean = (rows: Row[]) => redactDeep(rows, cfg.capture.redact, cfg.capture.maxFieldBytes);
	const targets =
		opts.format === "json"
			? [
					{
						path: opts.out.toLowerCase().endsWith(".json") ? opts.out : `${opts.out}.json`,
						tables: Object.keys(tables),
					},
				]
			: Object.keys(tables).map((t) => ({ path: `${opts.out}-${t}.csv`, tables: [t] }));
	if (!opts.force) {
		const existing = targets.find((t) => existsSync(t.path));
		if (existing) throw new UsageError(`${existing.path} exists; use --force to overwrite`);
	}
	return targets.map((t) => {
		if (opts.format === "json") {
			const body: Row = { exportedAt: (opts.now ?? new Date()).toISOString(), version: VERSION };
			for (const name of t.tables) body[name] = clean(tables[name]);
			writePrivate(t.path, `${JSON.stringify(body, null, 2)}\n`);
			return { path: t.path, rows: t.tables.reduce((n, name) => n + tables[name].length, 0) };
		}
		const name = t.tables[0];
		const rows = clean(tables[name]);
		writePrivate(t.path, toCsv(rows, columnsOf(name, rows)));
		return { path: t.path, rows: rows.length };
	});
}

export function exportData(db: Db, opts: ExportOptions): string[] {
	return exportFiles(db, opts).map((f) => f.path);
}

export function registerExportCommand(program: Command): void {
	program
		.command("export")
		.description("write sessions, usage and tool calls to JSON or CSV (redacted with the current patterns)")
		.addOption(
			new Option("--format <format>", "json (one file) or csv (three files)").choices(["json", "csv"]).default("json"),
		)
		.option("--out <path>", "file name without extension (default ./cc-debrief-export-<YYYYMMDD>)")
		.option("--days <n>", "only sessions started in the last n days", parsePositiveInt)
		.option("--repo <repo_id>", "only sessions in this repo")
		.option("--include-raw", "also write stored transcript lines and hook events (the most sensitive data)")
		.option("--force", "overwrite existing files")
		.action(
			async (opts: {
				format: "json" | "csv";
				out?: string;
				days?: number;
				repo?: string;
				includeRaw?: boolean;
				force?: boolean;
			}) => {
				if (opts.out === "") throw new InvalidArgumentError("--out needs a path");
				const out: Out = stdout;
				const now = new Date();
				await withDb((db) => {
					for (const f of exportFiles(db, {
						...opts,
						out: opts.out ?? `cc-debrief-export-${localDate(now).replaceAll("-", "")}`,
						now,
					})) {
						out(`wrote ${f.path} (${count(f.rows, "row")})`);
					}
				});
			},
		);
}

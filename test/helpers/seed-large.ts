// A large dashboard DB written straight with SQL (Phase 2 perf): 10,000 sessions over 90 days, each with 100
// transcript_lines, 20 usage, 30 tool_calls, 5 file_changes and 10 inventory_usage rows (1M transcript lines).
// Deterministic for a given `now`.
import type { Db } from "../../src/db/adapter";
import { encodePayload } from "../../src/ingest/line";

export const LARGE = { sessions: 10_000, days: 90, lines: 100, usage: 20, calls: 30, files: 5, inventory: 10 };

const MODELS = ["claude-sonnet-4-5", "claude-opus-4-1", "claude-haiku-4-5"];
const SURFACES = ["cli", "vscode", "desktop"];
const TOOLS = ["Read", "Edit", "Bash", "Grep", "Glob", "Write"];

/** Fills db (migrated, empty). Returns the session ids, newest last. */
export function seedLarge(db: Db, now: Date, sizes: Partial<typeof LARGE> = {}): string[] {
	const z = { ...LARGE, ...sizes };
	const span = z.days * 86_400_000;
	const payload = encodePayload({ type: "assistant", message: { content: "x" } });
	const input = encodePayload({ command: "npm test" });
	const ids: string[] = [];
	db.transaction(() => {
		const repo = db.prepare("INSERT INTO repos (repo_id, root_path, name) VALUES (?, ?, ?)");
		for (let r = 0; r < 20; r++) repo.run(`github.com/org/repo${r}`, `/w/repo${r}`, `repo${r}`);
		const inv = db.prepare(
			`INSERT INTO inventory (scope, kind, name, path, description, first_seen, last_seen)
			 VALUES ('user', 'skill', ?, ?, ?, '2026-01-01T00:00:00Z', ?)`,
		);
		for (let k = 0; k < 50; k++) inv.run(`skill-${k}`, `/s/skill-${k}`, "d".repeat(40 + k), now.toISOString());

		const session = db.prepare(
			`INSERT INTO sessions (session_id, started_at, ended_at, cwd, repo_id, branch, surface, capture, models, title)
			 VALUES (?, ?, ?, ?, ?, 'main', ?, 'hooks', ?, ?)`,
		);
		const file = db.prepare("INSERT INTO transcripts (path, session_id, size, mtime_ms) VALUES (?, ?, 0, 0)");
		const line = db.prepare(
			`INSERT INTO transcript_lines (session_id, file_id, line_no, uuid, type, ts, payload)
			 VALUES (?, ?, ?, ?, 'assistant', ?, ?)`,
		);
		const turn = db.prepare("INSERT INTO turns (session_id, seq, user_text, started_at) VALUES (?, ?, ?, ?)");
		const usage = db.prepare(
			`INSERT INTO usage (session_id, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
			   cost_usd, ts, message_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		const call = db.prepare(
			`INSERT INTO tool_calls (session_id, turn_id, tool_use_id, tool_name, input, started_at, ended_at, ok)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		const change = db.prepare(
			"INSERT INTO file_changes (session_id, repo_id, path, lines_added, lines_removed, language) VALUES (?, ?, ?, ?, ?, 'typescript')",
		);
		const use = db.prepare(
			"INSERT INTO inventory_usage (inventory_id, session_id, loaded, invoked) VALUES (?, ?, 1, ?)",
		);

		for (let s = 0; s < z.sessions; s++) {
			const id = `${String(s).padStart(8, "0")}-0000-4000-8000-000000000000`;
			ids.push(id);
			const start = now.getTime() - span + Math.floor((s / z.sessions) * span);
			const at = (ms: number) => new Date(start + ms).toISOString();
			const repoId = `github.com/org/repo${s % 20}`;
			session.run(
				id,
				at(0),
				at(z.lines * 1000),
				`/w/repo${s % 20}`,
				repoId,
				SURFACES[s % 3],
				`["${MODELS[s % 3]}"]`,
				`Session ${s}`,
			);
			const fileId = Number(file.run(`/p/${id}.jsonl`, id).lastInsertRowid);
			for (let l = 0; l < z.lines; l++) line.run(id, fileId, l, `${id}-${l}`, at(l * 1000), payload);
			const turnId = Number(turn.run(id, 1, `prompt ${s} about repo${s % 20}`, at(0)).lastInsertRowid);
			for (let u = 0; u < z.usage; u++) {
				usage.run(id, MODELS[(s + u) % 3], 100 + u, 50, 200, 1000 + s, 0.01, at(u * 5000), `${id}-m${u}`);
			}
			for (let c = 0; c < z.calls; c++) {
				call.run(
					id,
					turnId,
					`${id}-t${c}`,
					TOOLS[c % TOOLS.length],
					input,
					at(c * 3000),
					at(c * 3000 + 500),
					c % 10 === 0 ? 0 : 1,
				);
			}
			for (let f = 0; f < z.files; f++) change.run(id, repoId, `src/file${(s + f) % 200}.ts`, 10 + f, f);
			for (let k = 0; k < z.inventory; k++) use.run(((s + k) % 50) + 1, id, k === 0 && s % 7 === 0 ? 1 : 0);
		}
	});
	return ids;
}

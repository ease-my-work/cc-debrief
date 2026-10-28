// Sessions ready (or not) for an AI summary, written straight into the derived tables: n turns with a Read each, an
// optional SessionEnd event, and a transcripts row whose file is present (resume mode) or gone (stored-turns mode).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "../../src/db/adapter";

export const HOUR = 3_600_000;
export const isoAgo = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

export type SummarySeed = {
	turns?: number;
	capture?: "hooks" | "backfill";
	ended?: boolean;
	lastLineAgo?: number;
	file?: "present" | "gone";
	startedAgo?: number;
	typeSource?: "ai" | "heuristic";
};

export function seedSummarizable(db: Db, claudeDir: string, id: string, s: SummarySeed = {}): void {
	db.prepare(
		"INSERT INTO sessions (session_id, started_at, ended_at, capture, type_source, summary) VALUES (?, ?, ?, ?, ?, ?)",
	).run(
		id,
		isoAgo(s.startedAgo ?? 3 * HOUR),
		isoAgo(s.lastLineAgo ?? 2 * HOUR),
		s.capture ?? "hooks",
		s.typeSource ?? null,
		s.typeSource === "ai" ? "x" : null,
	);
	for (let i = 0; i < (s.turns ?? 3); i++) {
		const turn = Number(
			db
				.prepare("INSERT INTO turns (session_id, seq, user_text, assistant_text) VALUES (?, ?, ?, ?)")
				.run(id, i, `please do step ${i}`, `did step ${i}`).lastInsertRowid,
		);
		db.prepare("INSERT INTO tool_calls (session_id, turn_id, tool_name, ok) VALUES (?, ?, 'Read', 1)").run(id, turn);
	}
	if (s.ended ?? true) {
		db.prepare("INSERT INTO events (session_id, event, ts, payload) VALUES (?, 'SessionEnd', ?, '{}')").run(
			id,
			isoAgo(HOUR),
		);
	}
	const dir = join(claudeDir, "projects", "proj");
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `${id}.jsonl`);
	if ((s.file ?? "present") === "present") writeFileSync(path, "{}\n");
	db.prepare("INSERT INTO transcripts (path, session_id, size, mtime_ms) VALUES (?, ?, 3, 0)").run(path, id);
}

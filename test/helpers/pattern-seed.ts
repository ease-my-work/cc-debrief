// Sessions with controlled skeletons, labels, prompts, files and tokens for repeat-pattern tests (Phase 5b plan).
import type { Db } from "../../src/db/adapter";
import { encodePayload } from "../../src/ingest/line";

export type PatternSeed = {
	repo?: string | null;
	startedAt?: string;
	/** Tier 2 task_pattern; stored as a reviews row. */
	label?: string;
	/** [tool_name, input, mcp_server?] in order. */
	calls?: [string, Record<string, unknown>, string?][];
	/** User prompts in order; the first is the session's first prompt. */
	prompts?: string[];
	/** Non-cached tokens, as one usage row of input tokens. */
	tokens?: number;
	sessionType?: string | null;
	/** Paths edited (file_changes rows). */
	edits?: string[];
	durationMin?: number;
};

const DAY = 86_400_000;
export const PATTERN_NOW = new Date("2026-10-10T12:00:00.000Z");
export const daysAgo = (d: number, now = PATTERN_NOW) => new Date(now.getTime() - d * DAY).toISOString();

/** A trivy-fix skeleton: 5 distinct steps. */
export const TRIVY_CALLS: [string, Record<string, unknown>][] = [
	["Bash", { command: "trivy image app" }],
	["Read", { file_path: "/r/Dockerfile" }],
	["Edit", { file_path: "/r/Dockerfile" }],
	["Bash", { command: "docker build ." }],
	["Bash", { command: "trivy image app:new" }],
];

export function ensureRepo(db: Db, repoId: string, root = `/repos/${repoId}`): void {
	db.prepare("INSERT OR IGNORE INTO repos (repo_id, root_path, name) VALUES (?, ?, ?)").run(repoId, root, repoId);
}

export function seedPatternSession(db: Db, id: string, s: PatternSeed = {}): string {
	const repo = s.repo === undefined ? "ra" : s.repo;
	if (repo) ensureRepo(db, repo);
	const start = s.startedAt ?? daysAgo(2);
	const end = new Date(Date.parse(start) + (s.durationMin ?? 30) * 60_000).toISOString();
	db.prepare(
		"INSERT INTO sessions (session_id, started_at, ended_at, repo_id, capture, session_type) VALUES (?, ?, ?, ?, 'hooks', ?)",
	).run(id, start, end, repo, s.sessionType ?? null);
	const prompts = s.prompts ?? [`work on ${id}`];
	const turnIds = prompts.map((p, i) =>
		Number(
			db
				.prepare("INSERT INTO turns (session_id, seq, user_text, started_at) VALUES (?, ?, ?, ?)")
				.run(id, i + 1, p, new Date(Date.parse(start) + i * 60_000).toISOString()).lastInsertRowid,
		),
	);
	db.prepare("INSERT INTO usage (session_id, turn_id, input_tokens, ts) VALUES (?, ?, ?, ?)").run(
		id,
		turnIds[0],
		s.tokens ?? 30_000,
		start,
	);
	const call = db.prepare(
		`INSERT INTO tool_calls (session_id, turn_id, tool_use_id, tool_name, mcp_server, input, started_at, ok)
		 VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
	);
	(s.calls ?? []).forEach(([tool, input, server], i) => {
		call.run(
			id,
			turnIds[0],
			`${id}-c${i}`,
			tool,
			server ?? null,
			encodePayload(input),
			new Date(Date.parse(start) + 10_000 + i * 1000).toISOString(),
		);
	});
	if (s.label) {
		db.prepare(
			"INSERT INTO reviews (session_id, schema_version, result, cost_usd, model, created_at) VALUES (?, 1, ?, 0.1, NULL, ?)",
		).run(id, JSON.stringify({ task_pattern: s.label, goals: [], confidence: "high" }), end);
	}
	for (const path of s.edits ?? []) {
		db.prepare(
			"INSERT INTO file_changes (session_id, repo_id, path, lines_added, lines_removed) VALUES (?, ?, ?, 1, 0)",
		).run(id, repo, path);
	}
	return id;
}

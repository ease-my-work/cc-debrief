// A session written straight into the derived tables with Tier 1 material (Phase 4): `retry` adds npm test failing
// three times then passing, `churn` four reads of src/a.ts. Each of the 4 turns has 1000 tokens of usage.
import type { Db } from "../../src/db/adapter";
import { encodePayload } from "../../src/ingest/line";

export type CoachSeed = {
	startedAt?: string;
	repoId?: string | null;
	capture?: "hooks" | "backfill";
	retry?: boolean;
	churn?: boolean;
	tier1Version?: number | null;
};

const plus = (iso: string, min: number) => new Date(Date.parse(iso) + min * 60_000).toISOString();

export function seedCoachSession(db: Db, id: string, s: CoachSeed = {}): void {
	const start = s.startedAt ?? new Date(Date.now() - 3_600_000).toISOString();
	db.prepare(
		"INSERT INTO sessions (session_id, started_at, ended_at, repo_id, capture, tier1_version) VALUES (?, ?, ?, ?, ?, ?)",
	).run(id, start, plus(start, 40), s.repoId ?? null, s.capture ?? "hooks", s.tier1Version ?? null);
	const turnIds: number[] = [];
	for (let i = 1; i <= 4; i++) {
		turnIds.push(
			Number(
				db
					.prepare("INSERT INTO turns (session_id, seq, user_text, started_at, ended_at) VALUES (?, ?, ?, ?, ?)")
					.run(id, i, `step ${i}`, plus(start, (i - 1) * 10), plus(start, (i - 1) * 10 + 5)).lastInsertRowid,
			),
		);
		db.prepare("INSERT INTO usage (session_id, turn_id, input_tokens, ts) VALUES (?, ?, 1000, ?)").run(
			id,
			turnIds[i - 1],
			plus(start, (i - 1) * 10 + 4),
		);
	}
	const call = db.prepare(
		`INSERT INTO tool_calls (session_id, turn_id, tool_use_id, tool_name, input, response, started_at, ended_at, ok, exit_code)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	let n = 0;
	const add = (
		turn: number,
		tool: string,
		input: object,
		ok: boolean,
		min: number,
		bytes = 0,
		exit: number | null = null,
	) =>
		call.run(
			id,
			turnIds[turn - 1],
			`${id}-t${++n}`,
			tool,
			encodePayload(input),
			encodePayload({ bytes, isError: !ok, excerpt: "" }),
			plus(start, min),
			plus(start, min + 0.5),
			ok ? 1 : 0,
			exit,
		);
	if (s.retry) {
		add(1, "Bash", { command: "npm test" }, false, 1, 0, 1);
		add(1, "Edit", { file_path: "/r/a.ts" }, true, 2);
		add(1, "Bash", { command: "npm test" }, false, 3, 0, 1);
		add(2, "Bash", { command: "npm test" }, false, 11, 0, 1);
		add(2, "Bash", { command: "npm test" }, true, 13);
	}
	if (s.churn) for (const t of [1, 2, 3, 4]) add(t, "Read", { file_path: "/r/src/a.ts" }, true, (t - 1) * 10 + 2, 4000);
}

// Phase 7 fixture builder: sessions with usage rows (counted) or a cost-state total (reported), in local wall-clock
// times relative to PARITY_NOW, so a day means the same date in every TZ (npm run test:tz). Rows are written as derive
// would write them (usage.cost_usd priced at the built-in table unless given).
import { estimateCost } from "../../src/collector/prices";
import type { Db } from "../../src/db/adapter";

/** 15:00 local on 2026-10-17. */
export const PARITY_NOW = new Date(2026, 9, 17, 15, 0);
export const LEAK_PROMPT = "PARITYLEAK-91c2";
export const LEAK_FOLDER = "acme-confidential";

/** Local time `daysAgo` days before PARITY_NOW's day, at h:m. */
export const localAt = (daysAgo: number, h = 10, m = 0): string => new Date(2026, 9, 17 - daysAgo, h, m).toISOString();

export type UsageSeed = {
	ts?: string | null;
	model?: string;
	input?: number;
	output?: number;
	cacheWrite?: number;
	cacheRead?: number;
	/** Defaults to the built-in price; null = unknown model. */
	cost?: number | null;
};

export type ParitySession = {
	startedAt: string;
	endedAt?: string | null;
	repo?: { id: string; name: string; root?: string } | null;
	usage?: UsageSeed[];
	/** A cost-state total: reported_cost_usd and per-model reported usage. */
	reported?: {
		costUsd: number;
		models: Record<
			string,
			{ input?: number; output?: number; cacheRead?: number; cacheCreation?: number; costUsd?: number }
		>;
	};
	prompt?: string;
	permissionMode?: string | null;
	ccVersion?: string | null;
	cwd?: string;
	compactions?: number;
};

export function seedParitySession(db: Db, id: string, s: ParitySession): void {
	if (s.repo)
		db.prepare("INSERT OR IGNORE INTO repos (repo_id, root_path, name) VALUES (?, ?, ?)").run(
			s.repo.id,
			s.repo.root ?? `/home/u/code/${s.repo.name}`,
			s.repo.name,
		);
	db.prepare(
		`INSERT INTO sessions (session_id, started_at, ended_at, cwd, repo_id, capture, permission_mode, cc_version,
		   reported_cost_usd, reported_usage)
		 VALUES (?, ?, ?, ?, ?, 'hooks', ?, ?, ?, ?)`,
	).run(
		id,
		s.startedAt,
		s.endedAt === undefined ? new Date(Date.parse(s.startedAt) + 30 * 60_000).toISOString() : s.endedAt,
		s.cwd ?? (s.repo ? (s.repo.root ?? `/home/u/code/${s.repo.name}`) : "/home/u"),
		s.repo?.id ?? null,
		s.permissionMode ?? null,
		s.ccVersion ?? null,
		s.reported?.costUsd ?? null,
		s.reported ? JSON.stringify(s.reported.models) : null,
	);
	db.prepare("INSERT INTO turns (session_id, seq, user_text, started_at) VALUES (?, 1, ?, ?)").run(
		id,
		s.prompt ?? `work on ${id}`,
		s.startedAt,
	);
	const insert = db.prepare(
		`INSERT INTO usage (session_id, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
		   cost_usd, ts)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	for (const u of s.usage ?? []) {
		const model = u.model ?? "claude-sonnet-4-5";
		const r = {
			model,
			inputTokens: u.input ?? 0,
			outputTokens: u.output ?? 0,
			cacheCreationTokens: u.cacheWrite ?? 0,
			cacheCreation1hTokens: 0,
			cacheReadTokens: u.cacheRead ?? 0,
		};
		insert.run(
			id,
			model,
			r.inputTokens,
			r.outputTokens,
			r.cacheCreationTokens,
			r.cacheReadTokens,
			u.cost === undefined ? estimateCost(r) : u.cost,
			u.ts === undefined ? s.startedAt : u.ts,
		);
	}
	for (let i = 0; i < (s.compactions ?? 0); i++)
		db.prepare("INSERT INTO compactions (session_id, ts, trigger) VALUES (?, ?, 'auto')").run(id, s.startedAt);
}

export const REPO_A = { id: "github.com/acme/api", name: "api" };
export const REPO_B = { id: "github.com/acme/web", name: "web" };

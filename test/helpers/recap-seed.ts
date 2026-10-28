// Recap fixture (Phase 6 plan Task 4): sessions across two local days, repos with and without remotes, an agent
// worktree, titles, summaries, agent names, files, a prompt with a leak token and a file under a private directory.
// Times are local wall-clock times, so the fixture means the same days in every TZ.
import type { Db } from "../../src/db/adapter";
import { encodePayload } from "../../src/ingest/line";

/** The fixture's main day and the day before, as local dates. */
export const RECAP_DAY = "2026-09-28";
export const RECAP_PREV = "2026-09-27";
/** 18:00 local on the main day. */
export const RECAP_NOW = new Date(2026, 8, 28, 18, 0);
export const LEAK_TOKEN = "LEAKTOKEN-7f3a";
export const LEAK_DIR = "acme-private";

/** Local time on the main day (dayOffset -1 = the day before) as an ISO string. */
export const at = (h: number, m = 0, dayOffset = 0) => new Date(2026, 8, 28 + dayOffset, h, m).toISOString();

export const REPOS = {
	api: { id: "github.com/acme/api-gateway", root: "/home/u/code/api-gateway", name: "api-gateway", remote: true },
	checkout: {
		id: "github.com/acme/checkout-flow",
		root: "/home/u/code/checkout-flow",
		name: "checkout-flow",
		remote: true,
	},
	notes: { id: "/home/u/notes", root: "/home/u/notes", name: "notes", remote: false },
	notesWt: {
		id: "/home/u/notes/.claude/worktrees/fix-x",
		root: "/home/u/notes/.claude/worktrees/fix-x",
		name: "fix-x",
		remote: false,
	},
	secret: {
		id: "github.com/acme/secret-client",
		root: "/home/u/clients/secret-client",
		name: "secret-client",
		remote: true,
	},
} as const;
type RepoKey = keyof typeof REPOS;

export type RecapSeed = {
	repo?: RepoKey | null;
	cwd?: string;
	title?: string;
	agentName?: string;
	summary?: string;
	/** Turn start times (ISO); the first prompt text is `prompt`. */
	turns: string[];
	prompt?: string;
	/** Edits: full path, churn split as added lines, and when the tool call ran. */
	files?: { path: string; churn: number; at: string }[];
	/** Read tool calls: full path and when the call ran. */
	reads?: { path: string; at: string }[];
};

export function ensureRecapRepo(db: Db, key: RepoKey): void {
	const r = REPOS[key];
	db.prepare("INSERT OR IGNORE INTO repos (repo_id, root_path, remote_url, name) VALUES (?, ?, ?, ?)").run(
		r.id,
		r.root,
		r.remote ? `https://${r.id}.git` : null,
		r.name,
	);
}

export function seedRecapSession(db: Db, id: string, s: RecapSeed): void {
	const repo = s.repo ? REPOS[s.repo] : null;
	if (s.repo) ensureRecapRepo(db, s.repo);
	db.prepare(
		`INSERT INTO sessions (session_id, started_at, ended_at, cwd, repo_id, capture, title, agent_name, summary)
		 VALUES (?, ?, ?, ?, ?, 'hooks', ?, ?, ?)`,
	).run(
		id,
		s.turns[0],
		s.turns[s.turns.length - 1],
		s.cwd ?? repo?.root ?? null,
		repo?.id ?? null,
		s.title ?? null,
		s.agentName ?? null,
		s.summary ?? null,
	);
	const turn = db.prepare("INSERT INTO turns (session_id, seq, user_text, started_at) VALUES (?, ?, ?, ?)");
	const turnIds = s.turns.map((t, i) =>
		Number(turn.run(id, i + 1, i === 0 ? (s.prompt ?? `please work on ${id}`) : "continue", t).lastInsertRowid),
	);
	const call = db.prepare(
		"INSERT INTO tool_calls (session_id, turn_id, tool_use_id, tool_name, input, started_at, ok) VALUES (?, ?, ?, 'Edit', NULL, ?, 1)",
	);
	const change = db.prepare(
		"INSERT INTO file_changes (session_id, tool_call_id, repo_id, path, lines_added, lines_removed) VALUES (?, ?, ?, ?, ?, ?)",
	);
	(s.files ?? []).forEach((f, i) => {
		const callId = Number(call.run(id, turnIds[0], `${id}-e${i}`, f.at).lastInsertRowid);
		const added = Math.ceil(f.churn / 2);
		change.run(id, callId, repo?.id ?? null, f.path, added, f.churn - added);
	});
	const read = db.prepare(
		"INSERT INTO tool_calls (session_id, turn_id, tool_use_id, tool_name, input, started_at, ok) VALUES (?, ?, ?, 'Read', ?, ?, 1)",
	);
	(s.reads ?? []).forEach((r, i) => {
		read.run(id, turnIds[0], `${id}-r${i}`, encodePayload({ file_path: r.path }), r.at);
	});
}

const api = (f: string) => `/home/u/code/api-gateway/internal/${f}`;
const co = (f: string) => `/home/u/code/checkout-flow/src/${f}`;

/** The plan's recap fixture: 11 sessions, one excluded (1 turn, no files). */
export function seedRecapFixture(db: Db): void {
	// One transaction: ~100 autocommit inserts against the file DB stalled a Windows CI setup hook past 10 s.
	db.transaction(() => seedFixtureRows(db));
}

function seedFixtureRows(db: Db): void {
	seedRecapSession(db, "titled", {
		repo: "api",
		title: "Add rate limiting to the public endpoints",
		summary: "Added a limiter. Also tests.",
		prompt: `add a limiter ${LEAK_TOKEN} please`,
		turns: [at(9), at(9, 20), at(9, 40)],
		files: [
			{ path: api("errors.go"), churn: 40, at: at(9, 5) },
			{ path: api("gateway_test.go"), churn: 30, at: at(9, 10) },
			{ path: api("handlers.go"), churn: 20, at: at(9, 15) },
			{ path: api("routes.go"), churn: 5, at: at(9, 25) },
		],
	});
	seedRecapSession(db, "summary-only", {
		repo: "api",
		summary: "Fixed the flaky auth integration test. Then cleaned up.",
		turns: [at(11), at(11, 30)],
	});
	seedRecapSession(db, "one-turn", { repo: "api", title: "Quick question", turns: [at(12)] });
	seedRecapSession(db, "agent-only", {
		repo: "checkout",
		agentName: "Feat/ingest-worker ingest",
		turns: [at(10), at(10, 15)],
		files: [{ path: `/home/u/clients/${LEAK_DIR}/src/pay.ts`, churn: 12, at: at(10, 5) }],
	});
	seedRecapSession(db, "files-only", {
		repo: "checkout",
		turns: [at(14), at(14, 20)],
		files: [
			{ path: co("cart.tsx"), churn: 50, at: at(14, 1) },
			{ path: co("cart.test.tsx"), churn: 30, at: at(14, 2) },
			{ path: co("Summary.tsx"), churn: 20, at: at(14, 3) },
			{ path: co("api.ts"), churn: 10, at: at(14, 4) },
		],
	});
	seedRecapSession(db, "dup-a", {
		repo: "checkout",
		title: "Debug the failed webhook retry",
		turns: [at(15), at(15, 10)],
		files: [{ path: co("webhook.ts"), churn: 8, at: at(15, 5) }],
	});
	seedRecapSession(db, "dup-b", {
		repo: "checkout",
		title: "debug the failed webhook retry ",
		turns: [at(17), at(17, 10)],
		files: [{ path: co("retry.ts"), churn: 6, at: at(17, 5) }],
	});
	seedRecapSession(db, "read-only", {
		repo: "notes",
		turns: [at(8), at(8, 30)],
		reads: [
			{ path: "/home/u/notes/README.md", at: at(8, 1) },
			{ path: "/home/u/notes/plan.md", at: at(8, 2) },
			{ path: "/home/u/notes/README.md", at: at(8, 3) },
			{ path: "/home/u/notes/docs/todo.md", at: at(8, 4) },
			{ path: "/home/u/notes/plan.md", at: at(8, 5) },
			{ path: "/home/u/notes/README.md", at: at(8, 6) },
		],
	});
	seedRecapSession(db, "spanning", {
		repo: "notesWt",
		title: "Fix the export bug",
		turns: [at(23, 30, -1), at(0, 10), at(0, 40)],
		files: [
			{ path: "/home/u/notes/.claude/worktrees/fix-x/export.ts", churn: 9, at: at(23, 40, -1) },
			{ path: "/home/u/notes/.claude/worktrees/fix-x/export.test.ts", churn: 4, at: at(0, 20) },
		],
	});
	seedRecapSession(db, "no-repo", {
		repo: null,
		cwd: "/tmp/scratch",
		title: "Try a parser idea",
		turns: [at(16), at(16, 5)],
	});
	seedRecapSession(db, "secret", {
		repo: "secret",
		title: "Secret client billing",
		turns: [at(13), at(13, 20)],
		files: [{ path: "/home/u/clients/secret-client/invoice.ts", churn: 7, at: at(13, 5) }],
	});
}

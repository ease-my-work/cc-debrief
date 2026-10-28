// deriveSession(): rebuilds one session's derived rows from its stored transcript lines and hook events.
// Idempotent, synchronous, never runs git (feature 01 "Derivation", feature 02).
import { estimateCost } from "../collector/prices";
import { costStateFrom, type StoredLine, sessionTitles, type UsageRow, usageFromLines } from "../collector/transcript";
import type { Db } from "../db/adapter";
import { getMeta, setMeta } from "../db/queries/meta";
import { readSubagentMeta } from "../ingest/files";
import { decodePayload, encodePayload } from "../ingest/line";
import { capField } from "../redact";
import { deriveInventoryUsage, forgetSkillSignals, recordSkillSignals } from "./inventory-usage";
import { languageFor } from "./language";
import { activePricing } from "./pricing";
import { exitCodeFrom, parseToolName } from "./tools";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

const SENTINEL = "[cc-debrief:";
const SYNTHETIC = "<synthetic>";
const ASSISTANT_TEXT_MAX = 32_768;

export function surfaceFromEntrypoint(entrypoint: string | null): "cli" | "vscode" | "desktop" | "unknown" {
	if (entrypoint === "cli") return "cli";
	if (entrypoint === "claude-vscode") return "vscode";
	if (entrypoint === "claude-desktop") return "desktop";
	return "unknown";
}

// Only the line types derive reads (architecture "Derive cost"): prompts, replies, tool results, titles,
// cost-state, compactions, instructions and skill listings (inventory usage).
const DERIVED_TYPES = `(
		type IN ('user', 'assistant', 'custom-title', 'ai-title', 'agent-name', 'cost-state')
		OR (type = 'system' AND subtype = 'compact_boundary')
		OR (type = 'attachment' AND subtype IN ('instructions', 'skill_listing', 'dynamic_skill')))`;
const LOAD_LINES = `
	SELECT id, line_no, agent_id, uuid, type, subtype, ts, payload FROM transcript_lines
	WHERE session_id = ? AND ${DERIVED_TYPES}
	ORDER BY agent_id IS NOT NULL, file_id, line_no`;
// The append path: lines from a row id on. "+session_id" keeps SQLite on the rowid range, not the session index.
const LOAD_LINES_FROM = `
	SELECT id, line_no, agent_id, uuid, type, subtype, ts, payload FROM transcript_lines
	WHERE +session_id = ? AND id >= ? AND ${DERIVED_TYPES}
	ORDER BY agent_id IS NOT NULL, file_id, line_no`;

type LineRow = {
	id: number;
	line_no: number;
	agent_id: string | null;
	uuid: string | null;
	type: string;
	subtype: string | null;
	ts: string | null;
	payload: Uint8Array;
};
// Payloads ingest has just slimmed and stored, by transcript_lines.id: derive uses them instead of inflating the
// stored copy of what it wrote a moment ago (the backfill's derive would otherwise decode every line again).
let freshPayloads: Map<number, Obj> | null = null;

/** Runs fn with payloads for the given line ids available without decoding (ingest, right after storing them). */
export function withFreshPayloads<T>(payloads: Map<number, Obj>, fn: () => T): T {
	const prev = freshPayloads;
	freshPayloads = payloads;
	try {
		return fn();
	} finally {
		freshPayloads = prev;
	}
}

const toStored = (r: LineRow): StoredLine => ({
	id: r.id,
	lineNo: r.line_no,
	agentId: r.agent_id,
	uuid: r.uuid,
	type: r.type,
	subtype: r.subtype,
	ts: r.ts,
	payload: freshPayloads?.get(r.id) ?? (decodePayload(r.payload) as Obj),
});

function loadLines(db: Db, sessionId: string, fromId?: number): StoredLine[] {
	const rows =
		fromId === undefined
			? db.prepare(LOAD_LINES).all<LineRow>(sessionId)
			: db.prepare(LOAD_LINES_FROM).all<LineRow>(sessionId, fromId);
	return rows.map(toStored);
}

const content = (line: StoredLine): unknown => (isObj(line.payload.message) ? line.payload.message.content : undefined);

/** The prompt text of a user line, or null when the line is not a prompt (tool result, meta, command, …). */
export function promptText(line: StoredLine): string | null {
	if (line.type !== "user") return null;
	const p = line.payload;
	if (p.isMeta === true || p.isCompactSummary === true) return null;
	if (isObj(p.origin) && p.origin.kind === "task-notification") return null;
	const c = content(line);
	let text: string;
	if (typeof c === "string") text = c;
	else if (Array.isArray(c)) {
		if (c.some((b) => isObj(b) && b.type === "tool_result")) return null;
		const texts = c.filter((b) => isObj(b) && b.type === "text" && typeof b.text === "string").map((b) => b.text);
		if (texts.length === 0 && !c.some((b) => isObj(b) && b.type === "image")) return null;
		text = texts.join("\n");
	} else return null;
	const t = text.trimStart();
	if (
		t.startsWith("<command-") ||
		t.startsWith("<local-command-") ||
		t.startsWith("<task-notification>") ||
		t.startsWith("[Request interrupted by user") ||
		/^\/[A-Za-z][\w:-]*$/.test(t.trim())
	) {
		return null;
	}
	return text;
}

const isSynthetic = (line: StoredLine) => isObj(line.payload.message) && line.payload.message.model === SYNTHETIC;

// Main lines from a sentinel prompt up to the next real prompt: the tracker's own calls, never counted.
function sentinelLines(main: StoredLine[]): Set<StoredLine> {
	const out = new Set<StoredLine>();
	let inside = false;
	for (const line of main) {
		const text = promptText(line);
		if (text !== null) inside = text.startsWith(SENTINEL);
		if (inside) out.add(line);
	}
	return out;
}

type Turn = {
	seq: number;
	/** transcript_lines.id of the prompt line. */
	lineId: number | null;
	promptId: string | null;
	userText: string;
	assistantText: string | null;
	startedAt: string | null;
	endedAt: string | null;
};

function buildTurns(main: StoredLine[]): Turn[] {
	const turns: Turn[] = [];
	let current: (Turn & { texts: string[] }) | null = null;
	const close = () => {
		if (!current) return;
		const { texts, ...t } = current;
		turns.push({ ...t, assistantText: texts.length ? capField(texts.join("\n\n"), ASSISTANT_TEXT_MAX) : null });
	};
	for (const line of main) {
		const text = promptText(line);
		if (text !== null) {
			close();
			current = {
				seq: turns.length + 1,
				lineId: line.id ?? null,
				promptId: str(line.payload.promptId),
				userText: text,
				assistantText: null,
				startedAt: line.ts,
				endedAt: line.ts,
				texts: [],
			};
			continue;
		}
		if (!current) continue;
		if (line.ts) current.endedAt = line.ts;
		if (line.type === "assistant" && !isSynthetic(line)) {
			const c = content(line);
			if (Array.isArray(c)) {
				for (const b of c)
					if (isObj(b) && b.type === "text" && typeof b.text === "string" && b.text) current.texts.push(b.text);
			}
		}
	}
	close();
	return turns;
}

// The turn whose [started_at, next started_at) window holds ts; null before the first turn.
type TurnWindow = { id: number; startedAt: string | null };
// Per turn list: the turns with a start time, and whether those starts never decrease (then a binary search
// gives the same answer as the scan).
const timed = new WeakMap<TurnWindow[], { list: { id: number; startedAt: string }[]; sorted: boolean }>();
function turnFor(ts: string, turns: TurnWindow[]): number | null {
	let t = timed.get(turns);
	if (!t) {
		const list = turns.filter((x): x is { id: number; startedAt: string } => x.startedAt !== null);
		t = { list, sorted: list.every((x, i) => i === 0 || list[i - 1].startedAt <= x.startedAt) };
		timed.set(turns, t);
	}
	if (t.sorted) {
		let lo = 0;
		let hi = t.list.length; // first index whose start is after ts
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (t.list[mid].startedAt <= ts) lo = mid + 1;
			else hi = mid;
		}
		return lo > 0 ? t.list[lo - 1].id : null;
	}
	let found: number | null = null;
	for (const x of t.list) {
		if (x.startedAt <= ts) found = x.id;
		else break;
	}
	return found;
}

const firstString = (lines: StoredLine[], key: string): string | null => {
	for (const l of lines) {
		const v = str(l.payload[key]);
		if (v) return v;
	}
	return null;
};

type Order = { startedAt: string | null; sessionId: string };
// "Started first" (architecture, usage ownership): by started_at, unknown last, then by session id.
function isEarlier(a: Order, b: Order): boolean {
	if (a.startedAt !== b.startedAt) {
		if (a.startedAt === null) return false;
		if (b.startedAt === null) return true;
		return a.startedAt < b.startedAt;
	}
	return a.sessionId < b.sessionId;
}

// Subagent metadata: its .meta.json, else what the parent's Agent/Task result says, else what was stored before.
function subagentInfo(db: Db, sessionId: string, main: StoredLine[]) {
	const fromResults = new Map<string, { agentType: string | null; toolUseId: string | null }>();
	for (const line of main) {
		const r = line.payload.toolUseResult;
		const c = content(line);
		if (!isObj(r) || typeof r.agentId !== "string" || !Array.isArray(c)) continue;
		const result = c.find((b) => isObj(b) && b.type === "tool_result");
		fromResults.set(r.agentId, {
			agentType: str(r.agentType),
			toolUseId: isObj(result) ? str(result.tool_use_id) : null,
		});
	}
	const previous = new Map(
		db
			.prepare("SELECT agent_id, agent_type, description, tool_use_id FROM subagents WHERE session_id = ?")
			.all<{ agent_id: string; agent_type: string | null; description: string | null; tool_use_id: string | null }>(
				sessionId,
			)
			.map((r) => [r.agent_id, r]),
	);
	const files = db
		.prepare("SELECT path, agent_id FROM transcripts WHERE session_id = ? AND agent_id IS NOT NULL ORDER BY path")
		.all<{ path: string; agent_id: string }>(sessionId);
	if (files.length === 0) return [];
	const spans = new Map(
		db
			.prepare(
				`SELECT agent_id, min(ts) AS started_at, max(ts) AS ended_at FROM transcript_lines
				 WHERE session_id = ? AND agent_id IS NOT NULL AND ts IS NOT NULL GROUP BY agent_id`,
			)
			.all<{ agent_id: string; started_at: string | null; ended_at: string | null }>(sessionId)
			.map((r) => [r.agent_id, r]),
	);
	return files.map((f) => {
		const meta = readSubagentMeta({ path: f.path, sessionId, agentId: f.agent_id, size: 0, mtimeMs: 0 });
		const res = fromResults.get(f.agent_id);
		const prev = previous.get(f.agent_id);
		return {
			agentId: f.agent_id,
			agentType: meta?.agentType ?? res?.agentType ?? prev?.agent_type ?? null,
			description: meta?.description ?? prev?.description ?? null,
			toolUseId: meta?.toolUseId ?? res?.toolUseId ?? prev?.tool_use_id ?? null,
			startedAt: spans.get(f.agent_id)?.started_at ?? null,
			endedAt: spans.get(f.agent_id)?.ended_at ?? null,
		};
	});
}

/**
 * Rebuilds the session's sessions / turns / usage / subagents / compactions / instructions_loaded rows. The
 * sessions row is upserted, never deleted (AI, repo and git columns set by other workers are kept), unless the
 * main transcript is internal, in which case the session and everything derived from it go.
 *
 * When only new lines were appended since the last derive (the per-turn case), only the last turn and the new
 * lines are read (architecture "Derive cost"); `full` forces the whole rebuild (enrich, rebuild, rederive).
 */
export function deriveSession(db: Db, sessionId: string, opts: { full?: boolean } = {}): void {
	// The effective table's version (Phase 7: PRICE_TABLE_VERSION, or +<hash> with pricing overrides).
	const { version } = activePricing();
	if (getMeta(db, "price_table_version") !== version) setMeta(db, "price_table_version", version);

	const internal = db
		.prepare("SELECT 1 AS x FROM transcripts WHERE session_id = ? AND agent_id IS NULL AND internal = 1")
		.get(sessionId);
	if (internal) {
		db.transaction(() => {
			db.prepare("DELETE FROM sessions WHERE session_id = ?").run(sessionId); // dependent rows cascade
			forgetDerive(db, sessionId);
			forgetSkillSignals(db, sessionId);
		});
		return;
	}
	if (!opts.full) {
		const state = readState(db, sessionId);
		if (state && appendDerive(db, sessionId, state)) return;
	}
	fullDerive(db, sessionId);
}

// ---- Session-level fields shared by the full and append paths ----

const FIRST_KEYS = ["entrypoint", "gitBranch", "version", "permissionMode"] as const;
type Firsts = Record<(typeof FIRST_KEYS)[number], string | null>;

type Span = { s: string | null; e: string | null };
/** First and last line timestamps: of the main transcript, and of all the session's lines. */
type Bounds = { main: Span; all: Span };

function fullBounds(db: Db, sessionId: string): Bounds {
	const span = (where: string) =>
		db
			.prepare(
				`SELECT min(ts) AS s, max(ts) AS e FROM transcript_lines WHERE session_id = ? AND ts IS NOT NULL ${where}`,
			)
			.get<Span>(sessionId) ?? { s: null, e: null };
	return { main: span("AND agent_id IS NULL"), all: span("") };
}

const minOf = (a: string | null, b: string | null) => (a === null ? b : b === null || a <= b ? a : b);
const maxOf = (a: string | null, b: string | null) => (a === null ? b : b === null || a >= b ? a : b);

// Bounds and the highest line id after lastId, from the rowid range only (the append path).
function freshBounds(db: Db, sessionId: string, lastId: number, prev: Bounds): { bounds: Bounds; maxId: number } {
	const r = db
		.prepare(
			`SELECT min(ts) AS s, max(ts) AS e, max(id) AS m,
			   min(CASE WHEN agent_id IS NULL THEN ts END) AS ms, max(CASE WHEN agent_id IS NULL THEN ts END) AS me
			 FROM transcript_lines WHERE +session_id = ? AND id > ?`,
		)
		.get<{ s: string | null; e: string | null; m: number | null; ms: string | null; me: string | null }>(
			sessionId,
			lastId,
		);
	return {
		bounds: {
			main: { s: minOf(prev.main.s, r?.ms ?? null), e: maxOf(prev.main.e, r?.me ?? null) },
			all: { s: minOf(prev.all.s, r?.s ?? null), e: maxOf(prev.all.e, r?.e ?? null) },
		},
		maxId: Math.max(lastId, r?.m ?? 0),
	};
}

function sessionContext(db: Db, sessionId: string, b: Bounds) {
	// A session with no timed main line (subagent lines only) takes its span from all lines.
	const bounds = b.main.s ? b.main : b.all;
	const transcriptCwd = db
		.prepare(
			"SELECT cwd FROM transcripts WHERE session_id = ? AND cwd IS NOT NULL ORDER BY agent_id IS NOT NULL, id LIMIT 1",
		)
		.get<{ cwd: string }>(sessionId)?.cwd;
	const sessionStart = db
		.prepare("SELECT payload FROM events WHERE session_id = ? AND event = 'SessionStart' ORDER BY ts, id LIMIT 1")
		.get<{ payload: string }>(sessionId);
	let startReason: string | null = null;
	if (sessionStart) {
		try {
			startReason = str(JSON.parse(sessionStart.payload).source);
		} catch {
			startReason = null;
		}
	}
	return {
		startedAt: bounds?.s ?? null,
		endedAt: bounds?.e ?? null,
		cwd: transcriptCwd ?? null,
		hooks: sessionStart !== undefined,
		startReason,
	};
}

function addModels(models: string[], keptMain: StoredLine[]): string[] {
	for (const l of keptMain) {
		const m = l.type === "assistant" && isObj(l.payload.message) ? str(l.payload.message.model) : null;
		if (m && m !== SYNTHETIC && !models.includes(m)) models.push(m);
	}
	return models;
}

function upsertSession(
	db: Db,
	sessionId: string,
	ctx: ReturnType<typeof sessionContext>,
	firsts: Firsts,
	models: string[],
	titles: { title: string | null; agentName: string | null },
): void {
	db.prepare(
		`INSERT INTO sessions (session_id, started_at, ended_at, cwd, branch, surface, entrypoint, cc_version, capture,
		   start_reason, permission_mode, models, title, agent_name)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT (session_id) DO UPDATE SET
		   started_at = excluded.started_at, ended_at = excluded.ended_at, cwd = coalesce(excluded.cwd, sessions.cwd),
		   branch = coalesce(sessions.branch, excluded.branch), surface = excluded.surface,
		   entrypoint = excluded.entrypoint, cc_version = excluded.cc_version, capture = excluded.capture,
		   start_reason = excluded.start_reason, permission_mode = excluded.permission_mode, models = excluded.models,
		   title = excluded.title, agent_name = excluded.agent_name`,
	).run(
		sessionId,
		ctx.startedAt,
		ctx.endedAt,
		ctx.cwd,
		firsts.gitBranch,
		surfaceFromEntrypoint(firsts.entrypoint),
		firsts.entrypoint,
		firsts.version,
		ctx.hooks ? "hooks" : "backfill",
		ctx.startReason,
		firsts.permissionMode,
		JSON.stringify(models),
		titles.title,
		titles.agentName,
	);
}

function setReported(db: Db, sessionId: string, reported: ReturnType<typeof costStateFrom>): void {
	db.prepare("UPDATE sessions SET reported_cost_usd = ?, reported_usage = ? WHERE session_id = ?").run(
		reported?.totalCostUsd ?? null,
		reported
			? JSON.stringify(
					Object.fromEntries(
						Object.entries(reported.models).map(([m, u]) => [
							m,
							{
								input: u.inputTokens,
								output: u.outputTokens,
								thinking: u.thinkingTokens,
								cacheRead: u.cacheReadTokens,
								cacheCreation: u.cacheCreationTokens,
								costUsd: u.costUsd,
							},
						]),
					),
				)
			: null,
		sessionId,
	);
}

function writeSubagents(db: Db, sessionId: string, subagents: ReturnType<typeof subagentInfo>): void {
	db.prepare("DELETE FROM subagents WHERE session_id = ?").run(sessionId);
	const insertSub = db.prepare(
		`INSERT INTO subagents (session_id, agent_id, agent_type, description, tool_use_id, started_at, ended_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
	);
	for (const s of subagents) {
		insertSub.run(sessionId, s.agentId, s.agentType, s.description, s.toolUseId, s.startedAt, s.endedAt);
	}
}

function insertCompactionsAndInstructions(db: Db, sessionId: string, main: StoredLine[]): void {
	const insertCompaction = db.prepare(
		"INSERT INTO compactions (session_id, ts, trigger, pre_tokens, post_tokens) VALUES (?, ?, ?, ?, ?)",
	);
	const insertInstruction = db.prepare(
		"INSERT INTO instructions_loaded (session_id, file_path, kind, ts) VALUES (?, ?, ?, ?)",
	);
	for (const l of main) {
		if (l.type === "system" && l.subtype === "compact_boundary") {
			const m = isObj(l.payload.compactMetadata) ? l.payload.compactMetadata : {};
			const n = (v: unknown) => (typeof v === "number" ? v : null);
			insertCompaction.run(sessionId, l.ts, str(m.trigger), n(m.preTokens), n(m.postTokens));
		} else if (l.type === "attachment" && isObj(l.payload.attachment) && Array.isArray(l.payload.attachment.files)) {
			for (const f of l.payload.attachment.files) {
				if (isObj(f) && typeof f.path === "string") insertInstruction.run(sessionId, f.path, str(f.type), l.ts);
			}
		}
	}
}

function insertTurns(db: Db, sessionId: string, turns: Turn[]): void {
	const insertTurn = db.prepare(
		`INSERT INTO turns (session_id, prompt_id, seq, user_text, assistant_text, started_at, ended_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
	);
	for (const t of turns) {
		insertTurn.run(sessionId, t.promptId, t.seq, t.userText, t.assistantText, t.startedAt, t.endedAt);
	}
}

const turnWindows = (db: Db, sessionId: string) =>
	db
		.prepare("SELECT id, started_at AS startedAt FROM turns WHERE session_id = ? ORDER BY seq")
		.all<{ id: number; startedAt: string | null }>(sessionId);

// ---- Append state (meta derive:<session_id>) ----

// Bump when derivation changes, so every session gets one full rebuild.
const DERIVE_VERSION = 2;
type DeriveState = {
	v: number;
	price: string;
	/** Highest transcript_lines.id derived. Whatever deletes a session's lines calls forgetDerive(). */
	lastId: number;
	lastTurnLineId: number | null;
	bounds: Bounds;
	/** Row ids of the newest valid title / agent-name / cost-state lines of the main transcript. */
	latest: Record<string, number>;
	shared: boolean;
	sentinel: boolean;
	firsts: Firsts;
};
const stateKey = (sessionId: string) => `derive:${sessionId}`;

/** Drops the append state, so the next deriveSession() rebuilds in full. */
export function forgetDerive(db: Db, sessionId: string): void {
	db.prepare("DELETE FROM meta WHERE key = ?").run(stateKey(sessionId));
}

function readState(db: Db, sessionId: string): DeriveState | null {
	const raw = getMeta(db, stateKey(sessionId));
	if (!raw) return null;
	try {
		const s = JSON.parse(raw) as DeriveState;
		return s.v === DERIVE_VERSION && s.price === activePricing().version ? s : null;
	} catch {
		return null;
	}
}

function writeState(db: Db, sessionId: string, st: Omit<DeriveState, "v" | "price">): void {
	setMeta(db, stateKey(sessionId), JSON.stringify({ v: DERIVE_VERSION, price: activePricing().version, ...st }));
}

// The line types read whole for session-level fields, with what makes one count.
const LATEST: Record<string, (l: StoredLine) => boolean> = {
	"custom-title": (l) => sessionTitles([l]).title !== null,
	"ai-title": (l) => sessionTitles([l]).title !== null,
	"agent-name": (l) => sessionTitles([l]).agentName !== null,
	"cost-state": (l) => costStateFrom([l]) !== null,
};

/** Row id of the newest valid line of each LATEST type among main lines. */
function latestIds(main: StoredLine[]): Record<string, number> {
	const best: Record<string, StoredLine> = {};
	for (const l of main) {
		const valid = LATEST[l.type];
		if (!valid || l.agentId !== null || l.id === undefined || !valid(l)) continue;
		const prev = best[l.type];
		if (!prev || l.lineNo >= prev.lineNo) best[l.type] = l;
	}
	return Object.fromEntries(Object.entries(best).map(([t, l]) => [t, l.id as number]));
}

function linesById(db: Db, ids: number[]): StoredLine[] {
	if (ids.length === 0) return [];
	return db
		.prepare(
			`SELECT id, line_no, agent_id, uuid, type, subtype, ts, payload FROM transcript_lines
			 WHERE id IN (${ids.map(() => "?").join(",")})`,
		)
		.all<LineRow>(...ids)
		.map(toStored);
}

function fullDerive(db: Db, sessionId: string): void {
	const lines = loadLines(db, sessionId);
	const main = lines.filter((l) => l.agentId === null);
	const sentinel = sentinelLines(main);
	const kept = lines.filter((l) => !sentinel.has(l));
	const keptMain = kept.filter((l) => l.agentId === null);

	const bounds = fullBounds(db, sessionId);
	const ctx = sessionContext(db, sessionId, bounds);
	const firsts = Object.fromEntries(FIRST_KEYS.map((k) => [k, firstString(main, k)])) as Firsts;
	const models = addModels([], keptMain);
	const titles = sessionTitles(main);
	const turns = buildTurns(keptMain);
	const usage = usageFromLines(kept);
	const costState = costStateFrom(main);
	const subagents = subagentInfo(db, sessionId, main);

	db.transaction(() => {
		upsertSession(db, sessionId, ctx, firsts, models, titles);
		for (const table of ["file_changes", "tool_calls", "turns", "usage", "compactions", "instructions_loaded"]) {
			db.prepare(`DELETE FROM ${table} WHERE session_id = ?`).run(sessionId);
		}
		insertTurns(db, sessionId, turns);
		const turnIds = turnWindows(db, sessionId);

		const sharesWithEarlier = insertOwnedUsage(db, sessionId, ctx.startedAt, usage, turnIds);
		setReported(db, sessionId, costState && !sharesWithEarlier && sentinel.size === 0 ? costState : null);
		writeSubagents(db, sessionId, subagents);
		writeToolCalls(db, sessionId, collectToolCalls(kept), turnIds, subagents, null);
		insertCompactionsAndInstructions(db, sessionId, main);
		recordSkillSignals(db, sessionId, kept, true);
		deriveInventoryUsage(db, sessionId);

		const lastId =
			db.prepare("SELECT max(id) AS m FROM transcript_lines WHERE session_id = ?").get<{ m: number | null }>(sessionId)
				?.m ?? 0;
		writeState(db, sessionId, {
			lastId,
			lastTurnLineId: turns.at(-1)?.lineId ?? null,
			bounds,
			latest: latestIds(main),
			shared: sharesWithEarlier,
			sentinel: sentinel.size > 0,
			firsts,
		});
	});
}

/**
 * With enrich's numstat reconciliation stored (meta numstat:<id>), whether the new lines add or complete an edit of a
 * reconciled file: its last patch-less Write row takes the numstat counts, so a full rebuild re-applies them. Edits
 * to other files, and turns without edits (a resumed session), stay on the append path.
 */
function editsReconciledFile(db: Db, sessionId: string, fresh: StoredLine[]): boolean {
	const stored = getMeta(db, `numstat:${sessionId}`);
	if (stored === null) return false;
	let numstat: { repoId: string; paths: Record<string, unknown> };
	try {
		numstat = JSON.parse(stored);
	} catch {
		return true;
	}
	const repos = db.prepare("SELECT repo_id, root_path FROM repos").all<{ repo_id: string; root_path: string }>();
	const reconciled = (call: ToolCall) => {
		const fc = fileChange(call, repos);
		return fc !== null && fc.repoId === numstat.repoId && fc.path in numstat.paths;
	};
	const { calls, results } = collectToolCalls(fresh);
	if (calls.some((c) => EDIT_TOOLS.has(c.name) && reconciled(c))) return true;
	// A result for an edit call stored earlier without one.
	const waiting = db
		.prepare("SELECT tool_use_id, tool_name, input FROM tool_calls WHERE session_id = ? AND response IS NULL")
		.all<{ tool_use_id: string; tool_name: string; input: Uint8Array | null }>(sessionId);
	return waiting.some((w) => {
		const result = results.get(w.tool_use_id);
		if (!result || !EDIT_TOOLS.has(w.tool_name)) return false;
		return reconciled({
			id: w.tool_use_id,
			name: w.tool_name,
			input: w.input ? decodePayload(w.input) : null,
			agentId: null,
			startedAt: null,
			line: result.line,
			result,
		});
	});
}

// A subagent's calls take the turn of the main call that started it, else their own start time's turn (as
// writeToolCalls does); the parent may have been read after them.
function reassignSubagentCalls(
	db: Db,
	sessionId: string,
	subagents: { agentId: string; toolUseId: string | null }[],
	turns: { id: number; startedAt: string | null }[],
): void {
	const calls = db
		.prepare("SELECT id, agent_id, tool_use_id, turn_id, started_at FROM tool_calls WHERE session_id = ?")
		.all<{
			id: number;
			agent_id: string | null;
			tool_use_id: string;
			turn_id: number | null;
			started_at: string | null;
		}>(sessionId);
	const mainTurn = new Map(calls.filter((c) => c.agent_id === null).map((c) => [c.tool_use_id, c.turn_id]));
	const parentOf = new Map(subagents.map((s) => [s.agentId, s.toolUseId]));
	const set = db.prepare("UPDATE tool_calls SET turn_id = ? WHERE id = ?");
	for (const c of calls) {
		if (c.agent_id === null) continue;
		const parent = parentOf.get(c.agent_id);
		const parentTurn = parent ? mainTurn.get(parent) : undefined;
		const turnId = parentTurn !== undefined ? parentTurn : c.started_at ? turnFor(c.started_at, turns) : null;
		if (turnId !== c.turn_id) set.run(turnId, c.id);
	}
}

/**
 * The append path: the session's lines up to state.lastId are unchanged, so only the last turn and the lines
 * after it are read. Returns false (nothing written) when a full rebuild is needed instead.
 */
function appendDerive(db: Db, sessionId: string, state: DeriveState): boolean {
	if (state.sentinel) return false;
	// A subagent file seen for the first time without its .meta.json takes its type and parent call from the main
	// transcript's Agent result, which may be in lines already derived: rebuild in full once.
	const newSubagentWithoutMeta = db
		.prepare(
			`SELECT t.path, t.agent_id FROM transcripts t
			 WHERE t.session_id = ? AND t.agent_id IS NOT NULL
			   AND NOT EXISTS (SELECT 1 FROM subagents s WHERE s.session_id = t.session_id AND s.agent_id = t.agent_id)`,
		)
		.all<{ path: string; agent_id: string }>(sessionId)
		.some((f) => !readSubagentMeta({ path: f.path, sessionId, agentId: f.agent_id, size: 0, mtimeMs: 0 }));
	if (newSubagentWithoutMeta) return false;
	const row = db.prepare("SELECT models FROM sessions WHERE session_id = ?").get<{ models: string | null }>(sessionId);
	if (!row) return false;
	let models: string[];
	try {
		models = JSON.parse(row.models ?? "[]");
	} catch {
		return false;
	}

	const from = Math.min(state.lastTurnLineId ?? state.lastId + 1, state.lastId + 1);
	const window = loadLines(db, sessionId, from);
	const fresh = window.filter((l) => (l.id ?? 0) > state.lastId);
	const freshMain = fresh.filter((l) => l.agentId === null);
	if (freshMain.some((l) => promptText(l)?.startsWith(SENTINEL))) return false;
	if (editsReconciledFile(db, sessionId, fresh)) return false;
	// The last turn (from its prompt line on) plus the new main lines.
	const turnLines = state.lastTurnLineId === null ? freshMain : window.filter((l) => l.agentId === null);

	const { bounds, maxId } = freshBounds(db, sessionId, state.lastId, state.bounds);
	const ctx = sessionContext(db, sessionId, bounds);
	const firsts = Object.fromEntries(FIRST_KEYS.map((k) => [k, state.firsts[k] ?? firstString(freshMain, k)])) as Firsts;
	addModels(models, freshMain);
	// The newest title and cost-state lines: the ones kept in the state, or newer ones among the fresh lines.
	const latestLines = [...linesById(db, Object.values(state.latest)), ...freshMain.filter((l) => l.type in LATEST)];
	const titles = sessionTitles(latestLines);
	const costState = costStateFrom(latestLines);
	const turns = buildTurns(turnLines);
	const usage = usageFromLines(fresh);
	const subagents = subagentInfo(db, sessionId, freshMain);

	db.transaction(() => {
		upsertSession(db, sessionId, ctx, firsts, models, titles);

		const last = db
			.prepare("SELECT id, seq FROM turns WHERE session_id = ? ORDER BY seq DESC LIMIT 1")
			.get<{ id: number; seq: number }>(sessionId);
		let added = turns;
		if (state.lastTurnLineId !== null && last && turns.length > 0) {
			const t = turns[0];
			db.prepare(
				"UPDATE turns SET prompt_id = ?, user_text = ?, assistant_text = ?, started_at = ?, ended_at = ? WHERE id = ?",
			).run(t.promptId, t.userText, t.assistantText, t.startedAt, t.endedAt, last.id);
			added = turns.slice(1);
		}
		const base = last?.seq ?? 0;
		insertTurns(
			db,
			sessionId,
			added.map((t, i) => ({ ...t, seq: base + i + 1 })),
		);
		const turnIds = turnWindows(db, sessionId);

		// A message split across the append boundary: its later line wins, as in a full rebuild.
		const dropOwn = db.prepare(
			"DELETE FROM usage WHERE session_id = ? AND message_id = ? AND coalesce(request_id, '') = ?",
		);
		for (const u of usage) dropOwn.run(sessionId, u.messageId, u.requestId ?? "");
		const shared = insertOwnedUsage(db, sessionId, ctx.startedAt, usage, turnIds) || state.shared;
		setReported(db, sessionId, costState && !shared ? costState : null);
		writeSubagents(db, sessionId, subagents);

		const stored = new Map(
			db
				.prepare(
					`SELECT id, tool_use_id, tool_name, agent_id, turn_id, input, started_at, response
					 FROM tool_calls WHERE session_id = ?`,
				)
				.all<StoredCall>(sessionId)
				.map((c) => [c.tool_use_id, c]),
		);
		writeToolCalls(db, sessionId, collectToolCalls(fresh), turnIds, subagents, stored);
		// Rows stored before a new turn's prompt was read (another file ahead in time) move to that turn.
		const firstNew = added[0]?.startedAt ?? null;
		if (firstNew !== null) {
			const setUsage = db.prepare("UPDATE usage SET turn_id = ? WHERE id = ?");
			for (const u of db
				.prepare("SELECT id, ts FROM usage WHERE session_id = ? AND ts >= ?")
				.all<{ id: number; ts: string }>(sessionId, firstNew)) {
				setUsage.run(turnFor(u.ts, turnIds), u.id);
			}
			const setCall = db.prepare("UPDATE tool_calls SET turn_id = ? WHERE id = ?");
			for (const c of db
				.prepare("SELECT id, started_at FROM tool_calls WHERE session_id = ? AND agent_id IS NULL AND started_at >= ?")
				.all<{ id: number; started_at: string }>(sessionId, firstNew)) {
				setCall.run(turnFor(c.started_at, turnIds), c.id);
			}
		}
		reassignSubagentCalls(db, sessionId, subagents, turnIds);
		insertCompactionsAndInstructions(db, sessionId, freshMain);
		recordSkillSignals(db, sessionId, fresh, false);
		deriveInventoryUsage(db, sessionId);

		writeState(db, sessionId, {
			lastId: maxId,
			lastTurnLineId: turns.length > 0 ? (turns.at(-1)?.lineId ?? null) : state.lastTurnLineId,
			bounds,
			latest: latestIds(latestLines),
			shared,
			sentinel: false,
			firsts,
		});
	});
	return true;
}

/**
 * Inserts the session's usage rows under global ownership (Phase 0 A2): a key held by an earlier session stays
 * there; a key held by a later one is taken over and that session is queued for re-derivation. Returns whether
 * this session holds any message owned by an earlier session (a fork, rewind or branch copy).
 */
function insertOwnedUsage(
	db: Db,
	sessionId: string,
	startedAt: string | null,
	rows: UsageRow[],
	turns: { id: number; startedAt: string | null }[],
): boolean {
	const me: Order = { startedAt, sessionId };
	const { table } = activePricing();
	const holders = db.prepare(
		`SELECT u.id, u.session_id, s.started_at FROM usage u LEFT JOIN sessions s ON s.session_id = u.session_id
		 WHERE u.message_id = ? AND coalesce(u.request_id, '') = ? AND u.session_id <> ?`,
	);
	const remove = db.prepare("DELETE FROM usage WHERE id = ?");
	const insert = db.prepare(
		`INSERT OR IGNORE INTO usage (session_id, agent_id, turn_id, message_id, request_id, model, input_tokens,
		   output_tokens, cache_creation_tokens, cache_read_tokens, cost_usd, ts)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	let shared = false;
	for (const r of rows) {
		const others = holders.all<{ id: number; session_id: string; started_at: string | null }>(
			r.messageId,
			r.requestId ?? "",
			sessionId,
		);
		const owner = others.find((o) => !isEarlier(me, { startedAt: o.started_at, sessionId: o.session_id }));
		if (owner) {
			shared = true;
			continue;
		}
		for (const o of others) {
			remove.run(o.id);
			setMeta(db, `rederive:${o.session_id}`, "1");
		}
		insert.run(
			sessionId,
			r.agentId,
			r.ts ? turnFor(r.ts, turns) : null,
			r.messageId,
			r.requestId,
			r.model,
			r.inputTokens,
			r.outputTokens,
			r.cacheCreationTokens,
			r.cacheReadTokens,
			estimateCost(r, table),
			r.ts || null,
		);
	}
	return shared;
}

// ---- Tool calls and file changes (features 03 and 04) ----

type ToolCall = {
	id: string;
	name: string;
	input: unknown;
	agentId: string | null;
	startedAt: string | null;
	line: StoredLine;
	result?: { line: StoredLine; block: Obj };
};

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const EXIT_CODE_TOOLS = new Set(["Bash", "PowerShell"]);
const EXCERPT_BYTES = 4096;
const TRUNCATED = /…\[truncated \d+ bytes\]$/;

type ToolResult = { line: StoredLine; block: Obj };

/**
 * tool_use blocks (deduped by id, first line wins) paired with their tool_result by tool_use_id; `results` also
 * holds results whose tool_use is not among these lines (the append path pairs them with stored calls).
 */
function collectToolCalls(lines: StoredLine[]): { calls: ToolCall[]; results: Map<string, ToolResult> } {
	const calls = new Map<string, ToolCall>();
	const results = new Map<string, ToolResult>();
	for (const line of lines) {
		const c = content(line);
		if (!Array.isArray(c)) continue;
		for (const b of c) {
			if (!isObj(b)) continue;
			if (
				line.type === "assistant" &&
				b.type === "tool_use" &&
				typeof b.id === "string" &&
				typeof b.name === "string"
			) {
				if (!calls.has(b.id)) {
					calls.set(b.id, { id: b.id, name: b.name, input: b.input, agentId: line.agentId, startedAt: line.ts, line });
				}
			} else if (line.type === "user" && b.type === "tool_result" && typeof b.tool_use_id === "string") {
				if (!results.has(b.tool_use_id)) results.set(b.tool_use_id, { line, block: b });
			}
		}
	}
	return { calls: [...calls.values()].map((call) => ({ ...call, result: results.get(call.id) })), results };
}

const MARKER_N = /…\[truncated (\d+) bytes\]$/;

/**
 * Bytes of the result before redaction or slimLine() cut it: each text that ends in a `…[truncated N bytes]` marker
 * counts N instead of the marker (context churn, feature 07). null when nothing was cut.
 */
function originalBytes(value: unknown): number | null {
	const texts =
		typeof value === "string"
			? [value]
			: Array.isArray(value)
				? value.filter((b) => isObj(b) && typeof b.text === "string").map((b) => (b as { text: string }).text)
				: [];
	let cut = false;
	let total = Math.max(0, texts.length - 1); // the "\n" joins of resultText()
	for (const t of texts) {
		const m = MARKER_N.exec(t);
		total += Buffer.byteLength(t, "utf8");
		if (m) {
			cut = true;
			total += Number(m[1]) - Buffer.byteLength(m[0], "utf8");
		}
	}
	return cut ? total : null;
}

const resultText = (value: unknown): string =>
	typeof value === "string"
		? value
		: Array.isArray(value)
			? value
					.filter((b) => isObj(b) && typeof b.text === "string")
					.map((b) => (b as { text: string }).text)
					.join("\n")
			: "";

const RESULT_STRING_MAX = 1024;
const RESULT_FIELD_MAX = 200;

/**
 * The toolUseResult kept in tool_calls.response (architecture "tool_calls.response"): structuredPatch, filePath
 * and small scalar fields of an object; a string result capped at 1 KB. The whole result stays in
 * transcript_lines.
 */
function trimToolUseResult(t: unknown): unknown {
	if (typeof t === "string") return capField(t, RESULT_STRING_MAX);
	if (!isObj(t)) return null;
	const out: Obj = {};
	for (const [k, v] of Object.entries(t)) {
		if (k === "structuredPatch" || k === "filePath") out[k] = v;
		else if (typeof v === "number" || typeof v === "boolean") out[k] = v;
		else if (typeof v === "string" && v.length <= RESULT_FIELD_MAX) out[k] = v;
	}
	return out;
}

// The columns a tool call's result decides.
function resultFields(call: ToolCall) {
	const r = call.result;
	const denied = r ? str(r.line.payload.toolDenialKind) : null;
	const isError = r?.block.is_error === true;
	const ok = r ? (isError || denied ? 0 : 1) : null;
	let response: Uint8Array | null = null;
	if (r) {
		const text = resultText(r.block.content);
		const origBytes = originalBytes(r.block.content);
		response = encodePayload({
			toolUseResult: trimToolUseResult(r.line.payload.toolUseResult ?? null),
			bytes: Buffer.byteLength(text, "utf8"),
			isError,
			excerpt: capField(text, EXCERPT_BYTES),
			...(origBytes === null ? {} : { origBytes }),
		});
	}
	return {
		response,
		endedAt: r?.line.ts ?? null,
		ok,
		denied,
		exitCode: r && !denied && EXIT_CODE_TOOLS.has(call.name) ? exitCodeFrom(r.block.content) : null,
	};
}

/** A tool_calls row as the append path reads it back. */
type StoredCall = {
	id: number;
	tool_use_id: string;
	tool_name: string;
	agent_id: string | null;
	turn_id: number | null;
	input: Uint8Array | null;
	started_at: string | null;
	response: Uint8Array | null;
};

/**
 * Inserts tool_calls and their file_changes. With `stored` (the append path), calls already stored are kept (the
 * first tool_use wins) and a stored call without a result takes its result from these lines.
 */
function writeToolCalls(
	db: Db,
	sessionId: string,
	collected: { calls: ToolCall[]; results: Map<string, ToolResult> },
	turns: { id: number; startedAt: string | null }[],
	subagents: { agentId: string; toolUseId: string | null }[],
	stored: Map<string, StoredCall> | null,
): void {
	const insertCall = db.prepare(
		`INSERT INTO tool_calls (session_id, agent_id, turn_id, tool_use_id, tool_name, mcp_server, mcp_source, mcp_tool,
		   skill_name, input, response, started_at, ended_at, ok, denied, exit_code)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	const updateResult = db.prepare(
		"UPDATE tool_calls SET response = ?, ended_at = ?, ok = ?, denied = ?, exit_code = ? WHERE id = ?",
	);
	const insertChange = db.prepare(
		`INSERT INTO file_changes (session_id, tool_call_id, repo_id, path, lines_added, lines_removed, language, approx)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	const repos = db.prepare("SELECT repo_id, root_path FROM repos").all<{ repo_id: string; root_path: string }>();
	const changes: { rowId: number; repoId: string | null; path: string; patchlessWrite: boolean }[] = [];
	const addChange = (call: ToolCall, callId: number) => {
		if (!EDIT_TOOLS.has(call.name)) return;
		const fc = fileChange(call, repos);
		if (!fc) return;
		const rowId = Number(
			insertChange.run(
				sessionId,
				callId,
				fc.repoId,
				fc.path,
				fc.added,
				fc.removed,
				languageFor(fc.path),
				fc.approx ? 1 : 0,
			).lastInsertRowid,
		);
		changes.push({ rowId, repoId: fc.repoId, path: fc.path, patchlessWrite: call.name === "Write" && fc.patchless });
	};

	// Results for calls stored earlier without one.
	for (const prev of stored?.values() ?? []) {
		const result = collected.results.get(prev.tool_use_id);
		if (prev.response !== null || !result) continue;
		const call: ToolCall = {
			id: prev.tool_use_id,
			name: prev.tool_name,
			input: prev.input ? decodePayload(prev.input) : null,
			agentId: prev.agent_id,
			startedAt: prev.started_at,
			line: result.line,
			result,
		};
		const f = resultFields(call);
		updateResult.run(f.response, f.endedAt, f.ok, f.denied, f.exitCode, prev.id);
		if (f.ok === 1) addChange(call, prev.id);
	}

	// Main calls first: a subagent's calls take the turn of the main Agent/Task call that started it.
	const turnOfCall = new Map<string, number | null>(
		[...(stored?.values() ?? [])].map((c) => [c.tool_use_id, c.turn_id]),
	);
	const subagentParent = new Map(subagents.map((s) => [s.agentId, s.toolUseId]));
	const ordered = [...collected.calls].sort((a, b) => Number(a.agentId !== null) - Number(b.agentId !== null));
	for (const call of ordered) {
		if (stored?.has(call.id)) continue;
		let turnId: number | null = call.startedAt ? turnFor(call.startedAt, turns) : null;
		if (call.agentId !== null) {
			const parent = subagentParent.get(call.agentId);
			const parentTurn = parent ? turnOfCall.get(parent) : undefined;
			if (parentTurn !== undefined) turnId = parentTurn;
		}
		turnOfCall.set(call.id, turnId);

		const parsed = parseToolName(call.name, call.input);
		const f = resultFields(call);
		const callId = Number(
			insertCall.run(
				sessionId,
				call.agentId,
				turnId,
				call.id,
				call.name,
				str(call.line.payload.attributionMcpServer) ?? parsed.mcpServer,
				parsed.mcpSource,
				str(call.line.payload.attributionMcpTool) ?? parsed.mcpTool,
				parsed.skillName,
				encodePayload(call.input ?? null),
				f.response,
				call.startedAt,
				f.endedAt,
				f.ok,
				f.denied,
				f.exitCode,
			).lastInsertRowid,
		);
		if (f.ok === 1) addChange(call, callId);
	}
	if (!stored) applyNumstat(db, sessionId, changes); // the append path never runs with numstat stored
}

/**
 * Re-applies enrich's numstat reconciliation (meta numstat:<id>, feature 04 step 7): for a path whose rows are all
 * Write calls without a structuredPatch, the last row takes the numstat counts.
 */
function applyNumstat(
	db: Db,
	sessionId: string,
	changes: { rowId: number; repoId: string | null; path: string; patchlessWrite: boolean }[],
): void {
	const stored = getMeta(db, `numstat:${sessionId}`);
	if (!stored) return;
	let numstat: { repoId: string; paths: Record<string, { added: number; removed: number }> };
	try {
		numstat = JSON.parse(stored);
	} catch {
		return;
	}
	const byPath = new Map<string, typeof changes>();
	for (const c of changes) {
		if (c.repoId !== numstat.repoId) continue;
		byPath.set(c.path, [...(byPath.get(c.path) ?? []), c]);
	}
	const update = db.prepare("UPDATE file_changes SET lines_added = ?, lines_removed = ? WHERE id = ?");
	for (const [path, rows] of byPath) {
		const counts = numstat.paths[path];
		if (!counts || !rows.every((r) => r.patchlessWrite)) continue;
		update.run(counts.added, counts.removed, rows[rows.length - 1].rowId);
	}
}

const lineCount = (s: string): number => {
	if (s === "") return 0;
	const parts = s.split("\n");
	if (s.endsWith("\n")) parts.pop();
	return parts.length;
};

/** Path, repo and +/- line counts of a successful edit (feature 04 step 6); null without a path. */
function fileChange(call: ToolCall, repos: { repo_id: string; root_path: string }[]) {
	const input = isObj(call.input) ? call.input : {};
	const tur = call.result?.line.payload.toolUseResult;
	const result = isObj(tur) ? tur : {};
	const rawPath = str(result.filePath) ?? str(input.file_path) ?? str(input.notebook_path);
	if (!rawPath) return null;

	let added = 0;
	let removed = 0;
	const sources: string[] = [];
	const patch = Array.isArray(result.structuredPatch) ? result.structuredPatch : [];
	if (patch.length > 0) {
		for (const hunk of patch) {
			if (!isObj(hunk) || !Array.isArray(hunk.lines)) continue;
			for (const l of hunk.lines) {
				if (typeof l !== "string") continue;
				sources.push(l);
				if (l.startsWith("+")) added++;
				else if (l.startsWith("-")) removed++;
			}
		}
	} else {
		// Fallback without a patch: every old line removed, every new line added (a line diff of the input).
		const pair = (oldText: unknown, newText: unknown) => {
			const o = typeof oldText === "string" ? oldText : "";
			const n = typeof newText === "string" ? newText : "";
			sources.push(o, n);
			removed += lineCount(o);
			added += lineCount(n);
		};
		if (call.name === "Edit") pair(input.old_string, input.new_string);
		else if (call.name === "MultiEdit" && Array.isArray(input.edits)) {
			for (const e of input.edits) if (isObj(e)) pair(e.old_string, e.new_string);
		} else if (call.name === "NotebookEdit") pair("", input.new_source);
		else if (call.name === "Write") pair("", input.content);
	}

	const { repoId, path } = resolveRepo(rawPath, repos);
	return {
		path,
		repoId,
		added,
		removed,
		approx: sources.some((s) => TRUNCATED.test(s)),
		patchless: patch.length === 0,
	};
}

/**
 * The repos row with the longest root_path containing the file (case-insensitive for Windows paths), and the
 * path relative to it with "/" separators; the absolute path with "/" separators when no repo matches.
 */
export function resolveRepo(filePath: string, repos: { repo_id: string; root_path: string }[]) {
	const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
	const path = norm(filePath);
	const insensitive = process.platform === "win32" || /^[A-Za-z]:\//.test(path);
	const key = (p: string) => (insensitive ? p.toLowerCase() : p);
	let best: { repoId: string; root: string } | null = null;
	for (const r of repos) {
		const root = norm(r.root_path);
		if (root === "" || !key(path).startsWith(`${key(root)}/`)) continue;
		if (!best || root.length > best.root.length) best = { repoId: r.repo_id, root };
	}
	return best ? { repoId: best.repoId, path: path.slice(best.root.length + 1) } : { repoId: null, path };
}

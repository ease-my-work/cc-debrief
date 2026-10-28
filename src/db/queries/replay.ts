// GET /api/sessions/:id/replay (Phase 7 P8, feature 12): every turn with its full stored reply (≤ 32 KB, cut replies
// marked), tokens and cost from its usage rows (subagents' included, rows before the first turn on turn 1, so the
// turns sum to the counted total), its main-transcript tool chips and failures, and whether a compaction happened
// since the turn before. Session detail already shows prompts, so userText is allowed here.
import type { ReplayResponse } from "../../server/types";
import type { Db } from "../adapter";
import { chipLabel } from "./sessions";
import { money } from "./totals";

const TRUNCATED = /…\[truncated \d+ bytes\]$/;

export function getReplay(db: Db, sessionId: string): ReplayResponse | null {
	const exists = db.prepare("SELECT 1 AS x FROM sessions WHERE session_id = ?").get(sessionId);
	if (!exists) return null;
	const turns = db
		.prepare("SELECT id, seq, started_at, user_text, assistant_text FROM turns WHERE session_id = ? ORDER BY seq")
		.all<{
			id: number;
			seq: number;
			started_at: string | null;
			user_text: string | null;
			assistant_text: string | null;
		}>(sessionId);
	const firstId = turns[0]?.id ?? null;

	type Usage = { input: number; cacheWrite: number; cacheRead: number; output: number; cost: number; known: number };
	const usage = new Map<number, Usage>();
	for (const r of db
		.prepare(
			`SELECT turn_id, sum(input_tokens) AS i, sum(cache_creation_tokens) AS cw, sum(cache_read_tokens) AS cr,
			   sum(output_tokens) AS o, sum(cost_usd) AS cost, count(cost_usd) AS known
			 FROM usage WHERE session_id = ? GROUP BY turn_id`,
		)
		.all<{ turn_id: number | null; i: number; cw: number; cr: number; o: number; cost: number | null; known: number }>(
			sessionId,
		)) {
		const id = r.turn_id ?? firstId;
		if (id === null) continue;
		const u = usage.get(id) ?? { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, cost: 0, known: 0 };
		u.input += r.i;
		u.cacheWrite += r.cw;
		u.cacheRead += r.cr;
		u.output += r.o;
		u.cost += r.cost ?? 0;
		u.known += r.known;
		usage.set(id, u);
	}

	const chips = new Map<number, Map<string, { label: string; count: number; failures: number }>>();
	for (const c of db
		.prepare(
			`SELECT turn_id, tool_name, input, ok, denied FROM tool_calls
			 WHERE session_id = ? AND agent_id IS NULL AND turn_id IS NOT NULL ORDER BY started_at, id`,
		)
		.all<{ turn_id: number; tool_name: string; input: Uint8Array | null; ok: number | null; denied: string | null }>(
			sessionId,
		)) {
		const byLabel = chips.get(c.turn_id) ?? new Map();
		const label = chipLabel(c);
		const chip = byLabel.get(label) ?? { label, count: 0, failures: 0 };
		chip.count++;
		if (c.denied === null && c.ok === 0) chip.failures++;
		byLabel.set(label, chip);
		chips.set(c.turn_id, byLabel);
	}

	const compactions = db
		.prepare("SELECT ts FROM compactions WHERE session_id = ? AND ts IS NOT NULL")
		.all<{ ts: string }>(sessionId)
		.map((c) => c.ts);

	let running = 0;
	const cumulative: number[] = [];
	const out = turns.map((t, i) => {
		const u = usage.get(t.id);
		const tokens = {
			input: u?.input ?? 0,
			cacheWrite: u?.cacheWrite ?? 0,
			cacheRead: u?.cacheRead ?? 0,
			output: u?.output ?? 0,
		};
		running += tokens.input + tokens.cacheWrite + tokens.cacheRead + tokens.output;
		cumulative.push(running);
		const tools = [...(chips.get(t.id)?.values() ?? [])];
		const prev = i > 0 ? turns[i - 1].started_at : null;
		const text = t.assistant_text ?? "";
		return {
			seq: t.seq,
			startedAt: t.started_at,
			userText: t.user_text ?? "",
			assistantText: text,
			truncated: TRUNCATED.test(text),
			tokens,
			costUsd: u && u.known > 0 ? money(u.cost) : null,
			tools,
			failures: tools.reduce((n, c) => n + c.failures, 0),
			// A compaction since the turn before this one (between their starts) is shown on this turn.
			compaction:
				prev !== null && t.started_at !== null && compactions.some((ts) => ts > prev && ts <= (t.started_at as string)),
		};
	});
	return { turns: out, cumulative };
}

// Signal 1, long session with no compaction (feature 07 row 1, detail 1).
import type { SessionContext, Signal } from "../types";

const HOUR_MS = 3_600_000;
const MAX_WALL_MS = 2 * HOUR_MS; // spec: > 2 h
const MAX_TURNS = 40; // spec: > 40 turns
const HIGH_GAP_POINTS = 20;

const round4 = (x: number) => Math.round(x * 10_000) / 10_000;

/**
 * ended_at − started_at minus every gap between turns longer than an hour (the prompt-cache lifetime, Phase 0 C4),
 * so a session resumed the next day does not count the night. null without both times.
 */
export function wallMs(ctx: SessionContext): number | null {
	const { startedAt, endedAt } = ctx.session;
	if (!startedAt || !endedAt) return null;
	let ms = Date.parse(endedAt) - Date.parse(startedAt);
	for (let i = 1; i < ctx.turns.length; i++) {
		const prev = ctx.turns[i - 1];
		const prevEnd = prev.endedAt ?? prev.startedAt;
		const next = ctx.turns[i].startedAt;
		if (!prevEnd || !next) continue;
		const gap = Date.parse(next) - Date.parse(prevEnd);
		if (gap > HOUR_MS) ms -= gap;
	}
	return Math.max(0, ms);
}

export const longSession: Signal = {
	rule: "long_session_no_compaction",
	detect(ctx) {
		const median = ctx.userMedianCacheShare;
		if (median === null || ctx.compactions.length > 0) return [];
		const wall = wallMs(ctx) ?? 0;
		if (!(wall > MAX_WALL_MS || ctx.turns.length > MAX_TURNS)) return [];
		const { input, cacheCreation, cacheRead } = ctx.totals;
		const inputSide = input + cacheCreation + cacheRead;
		if (inputSide === 0) return [];
		const share = cacheRead / inputSide;
		if (share >= median) return [];
		const gapPoints = Math.round((median - share) * 10_000) / 100;
		return [
			{
				rule: this.rule,
				severity: gapPoints >= HIGH_GAP_POINTS ? "high" : "medium",
				message: `Long session with no compaction — cache hit ${Math.round(share * 100)}% vs your usual ${Math.round(median * 100)}%; split it or \`/compact\``,
				evidence: {
					wallMinutes: Math.round(wall / 60_000),
					turns: ctx.turns.length,
					share: round4(share),
					median: round4(median),
				},
				costTokens: Math.round((median - share) * inputSide),
				target: "session",
			},
		];
	},
};

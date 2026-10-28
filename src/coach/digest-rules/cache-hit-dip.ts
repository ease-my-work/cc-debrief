// Digest rule 3, cache hit dip (feature 09): a local day whose cache-read share of input-side tokens is more than
// 15 points below the median day of the last 30 days.
import { localDate } from "../../db/queries/range";
import type { DigestRule, Finding } from "../types";
import { daysBefore } from "./shared";

const MIN_DIP_POINTS = 15;
const LONG_MS = 2 * 3_600_000;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const round4 = (x: number) => Math.round(x * 10_000) / 10_000;

function medianOf(values: number[]): number | null {
	if (values.length === 0) return null;
	const s = [...values].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export const cacheHitDip: DigestRule = {
	rule: "cache_hit_dip",
	run(db, now) {
		const rows = db
			.prepare(
				`SELECT session_id, ts, input_tokens + cache_creation_tokens + cache_read_tokens AS side, cache_read_tokens AS cr
				 FROM usage WHERE ts >= ?`,
			)
			.all<{ session_id: string; ts: string; side: number; cr: number }>(daysBefore(now, 30));
		const days = new Map<string, { side: number; cr: number; sessions: Set<string> }>();
		for (const r of rows) {
			const day = localDate(new Date(r.ts));
			const d = days.get(day) ?? { side: 0, cr: 0, sessions: new Set<string>() };
			d.side += r.side;
			d.cr += r.cr;
			d.sessions.add(r.session_id);
			days.set(day, d);
		}
		const shares = new Map([...days].filter(([, d]) => d.side > 0).map(([day, d]) => [day, d.cr / d.side]));
		const median = medianOf([...shares.values()]);
		if (median === null) return [];

		const sessionRow = db.prepare(
			`SELECT started_at, ended_at, EXISTS (SELECT 1 FROM compactions c WHERE c.session_id = s.session_id) AS compacted
			 FROM sessions s WHERE session_id = ?`,
		);
		const out: Finding[] = [];
		for (const [day, share] of [...shares].sort(([a], [b]) => a.localeCompare(b))) {
			const points = Math.round((median - share) * 10_000) / 100;
			if (!(points > MIN_DIP_POINTS)) continue;
			const d = days.get(day) as { side: number; sessions: Set<string> };
			const sessions = [...d.sessions].sort();
			const longSessions = sessions.filter((id) => {
				const s = sessionRow.get<{ started_at: string | null; ended_at: string | null; compacted: number }>(id);
				return (
					!!s?.started_at && !!s.ended_at && !s.compacted && Date.parse(s.ended_at) - Date.parse(s.started_at) > LONG_MS
				);
			});
			const [y, m, dd] = day.split("-").map(Number);
			const weekday = WEEKDAYS[new Date(y, m - 1, dd).getDay()];
			const longText = `${longSessions.length} ${longSessions.length === 1 ? "session" : "sessions"}`;
			out.push({
				rule: this.rule,
				severity: "low",
				message: `${weekday} cache hit ${Math.round(share * 100)}% vs usual ${Math.round(median * 100)}% · ${longText} over 2 h without compaction`,
				evidence: { key: day, day, share: round4(share), median: round4(median), sessions, longSessions },
				costTokens: Math.round((median - share) * d.side),
				target: "overview",
				// The dip day, so a dip weeks ago is not in this week's digest (review B11).
				at: new Date(y, m - 1, dd).toISOString(),
			});
		}
		return out;
	},
};

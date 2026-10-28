// Batched session totals for the dashboard: the same rule as sessionTotals() (feature 02 "Session totals": reported
// when the session has a cost-state total, else counted from usage rows) for many sessions in two queries.
import type { Db } from "../adapter";

export type TokenSplit = { input: number; output: number; cacheWrite: number; cacheRead: number };
export type Totals = TokenSplit & {
	tokens: number;
	costUsd: number | null; // null: no usage rows, or every counted row has an unknown model
	partial: boolean; // counted (no cost-state total)
	hasUsage: boolean; // any usage row or reported total
	unknownTokens: number; // counted tokens of rows with an unknown model
	byModel: { model: string; tokens: number; costUsd: number | null }[];
	unattributed: TokenSplit; // reported − counted, floored at 0 (background requests)
};

const zero = (): TokenSplit => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });
const sum = (t: TokenSplit) => t.input + t.output + t.cacheWrite + t.cacheRead;
/** Rounds away float noise from summed dollar amounts. */
export const money = (n: number): number => Math.round(n * 1e6) / 1e6;

type ReportedModel = { input?: number; output?: number; cacheRead?: number; cacheCreation?: number; costUsd?: number };

/**
 * Totals for the sessions selected by `idsSql` (a SELECT returning session_id, with `params`), keyed by session id.
 * Sessions with neither usage rows nor a reported total get an all-zero entry.
 */
/** Usage summed per 10-minute UTC bucket (substr of ts to "YYYY-MM-DDTHH:M"); null when the row has no time. */
export type UsageBucket = {
	sessionId: string;
	bucket: string | null;
	input: number; // input + cache writes (the Overview chart's "input")
	cacheRead: number;
	output: number;
	/** Per-model detail of the same group (Phase 7 Costs). */
	model: string | null;
	inputOnly: number;
	cacheWrite: number;
	cost: number | null;
};

export function totalsFor(
	db: Db,
	idsSql: string,
	params: unknown[],
	opts: { onBucket?: (b: UsageBucket) => void } = {},
): Map<string, Totals> {
	const out = new Map<string, Totals>();
	const sessions = db
		.prepare(`SELECT session_id, reported_cost_usd, reported_usage FROM sessions WHERE session_id IN (${idsSql})`)
		.all<{ session_id: string; reported_cost_usd: number | null; reported_usage: string | null }>(...params);
	const counted = new Map<
		string,
		{
			split: TokenSplit;
			cost: number;
			known: number;
			unknown: number;
			models: Map<string, { tokens: number; cost: number | null }>;
		}
	>();
	for (const r of db
		.prepare(
			`SELECT session_id, model, sum(input_tokens) AS i, sum(output_tokens) AS o, sum(cache_creation_tokens) AS cw,
			   sum(cache_read_tokens) AS cr, sum(cost_usd) AS cost, count(cost_usd) AS known,
			   sum(CASE WHEN cost_usd IS NULL THEN input_tokens + output_tokens + cache_creation_tokens + cache_read_tokens ELSE 0 END) AS unk
			   ${opts.onBucket ? ", substr(ts, 1, 15) AS b" : ""}
			 FROM usage WHERE session_id IN (${idsSql}) GROUP BY session_id, model${opts.onBucket ? ", b" : ""}`,
		)
		.all<{
			session_id: string;
			model: string | null;
			i: number;
			o: number;
			cw: number;
			cr: number;
			cost: number | null;
			known: number;
			unk: number;
			b?: string | null;
		}>(...params)) {
		const c = counted.get(r.session_id) ?? { split: zero(), cost: 0, known: 0, unknown: 0, models: new Map() };
		c.split.input += r.i;
		c.split.output += r.o;
		c.split.cacheWrite += r.cw;
		c.split.cacheRead += r.cr;
		c.cost += r.cost ?? 0;
		c.known += r.known;
		c.unknown += r.unk;
		// One session and model can span several buckets: accumulate.
		const key = r.model ?? "unknown";
		const m = c.models.get(key) ?? { tokens: 0, cost: null };
		m.tokens += r.i + r.o + r.cw + r.cr;
		if (r.known > 0) m.cost = (m.cost ?? 0) + (r.cost ?? 0);
		c.models.set(key, m);
		opts.onBucket?.({
			sessionId: r.session_id,
			bucket: r.b ?? null,
			input: r.i + r.cw,
			cacheRead: r.cr,
			output: r.o,
			model: r.model,
			inputOnly: r.i,
			cacheWrite: r.cw,
			cost: r.known > 0 ? r.cost : null,
		});
		counted.set(r.session_id, c);
	}

	for (const s of sessions) {
		const c = counted.get(s.session_id);
		let reported: Record<string, ReportedModel> | null = null;
		if (s.reported_usage) {
			try {
				reported = JSON.parse(s.reported_usage);
			} catch {
				reported = null;
			}
		}
		if (reported) {
			const split = zero();
			const byModel = Object.entries(reported).map(([model, m]) => {
				const t = {
					input: m.input ?? 0,
					output: m.output ?? 0,
					cacheWrite: m.cacheCreation ?? 0,
					cacheRead: m.cacheRead ?? 0,
				};
				split.input += t.input;
				split.output += t.output;
				split.cacheWrite += t.cacheWrite;
				split.cacheRead += t.cacheRead;
				return { model, tokens: sum(t), costUsd: typeof m.costUsd === "number" ? m.costUsd : null };
			});
			const base = c?.split ?? zero();
			out.set(s.session_id, {
				...split,
				tokens: sum(split),
				costUsd: s.reported_cost_usd,
				partial: false,
				hasUsage: true,
				unknownTokens: 0,
				byModel,
				unattributed: {
					input: Math.max(0, split.input - base.input),
					output: Math.max(0, split.output - base.output),
					cacheWrite: Math.max(0, split.cacheWrite - base.cacheWrite),
					cacheRead: Math.max(0, split.cacheRead - base.cacheRead),
				},
			});
		} else {
			const split = c?.split ?? zero();
			out.set(s.session_id, {
				...split,
				tokens: sum(split),
				costUsd: c && c.known > 0 ? money(c.cost) : null,
				partial: true,
				hasUsage: c !== undefined,
				unknownTokens: c?.unknown ?? 0,
				byModel: [...(c?.models ?? new Map()).entries()].map(([model, m]) => ({
					model,
					tokens: m.tokens,
					costUsd: m.cost === null ? null : money(m.cost),
				})),
				unattributed: zero(),
			});
		}
	}
	return out;
}

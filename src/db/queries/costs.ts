// GET /api/costs (Phase 7 P3 + P6, feature 18). Every dollar is a session total (feature 02: reported when the
// session has a cost-state line, else counted), so the view's total equals the Overview cost tile. Per-day cost
// spreads each session's per-model cost over the days its usage rows fall on (by counted cost, else tokens, else the
// session's last-activity day), so the days sum to the total too. The tracker's own calls live in self_usage and are
// never read here.
import { modelFamily, modelLabel, PLAN_PRICES, type Price } from "../../collector/prices";
import type { Config } from "../../config";
import { activePricing } from "../../derive/pricing";
import type { CostsResponse, Range } from "../../server/types";
import type { Db } from "../adapter";
import { getBudget } from "./budget";
import { dayBuckets, localDate, rangeDays, rangeStart } from "./range";
import { money, type Totals, totalsFor } from "./totals";

const DAY_MS = 86_400_000;
const RUN_RATE_DAYS = 30;
/** Days per month for the run rate (365.25 / 12). */
const MONTH_DAYS = 365.25 / 12;
const NO_REPO = "no repo";
const OTHER = "Other";

export type UsageGroup = {
	session_id: string;
	model: string | null;
	b: string | null;
	i: number;
	o: number;
	cw: number;
	cr: number;
	cost: number | null;
};

/** Rounds away float noise without changing what a sum of many entries adds up to. */
const fine = (n: number) => Math.round(n * 1e9) / 1e9;

function sessionIds(range: Range, now: Date, repo?: string): { sql: string; params: unknown[] } {
	return {
		sql: `SELECT session_id FROM sessions WHERE started_at >= ?${repo ? " AND repo_id = ?" : ""}`,
		params: [rangeStart(range, now), ...(repo ? [repo] : [])],
	};
}

/** Sum of session totals (USD) for sessions started in the last RUN_RATE_DAYS days, every repo. */
function lastDaysUsd(db: Db, now: Date): number {
	const from = new Date(now.getTime() - RUN_RATE_DAYS * DAY_MS).toISOString();
	let usd = 0;
	for (const t of totalsFor(db, "SELECT session_id FROM sessions WHERE started_at >= ?", [from]).values())
		usd += t.costUsd ?? 0;
	return money(usd);
}

/**
 * Calls `put(iso, label, usd)` with each session's cost spread over time: per model, over its usage rows' 10-minute
 * buckets weighted by counted cost (else tokens), else at the session's last activity. A reported total that differs
 * from its per-model costs puts the rest on its largest model (or "Other"), so the parts sum to the session total.
 */
export function spreadCost(
	sessions: { session_id: string; last: string | null }[],
	totals: Map<string, Totals>,
	bySession: Map<string, UsageGroup[]>,
	now: Date,
	put: (iso: string, label: string, usd: number) => void,
): void {
	const bucketIso = (b: string) => `${b}0:00.000Z`;
	for (const s of sessions) {
		const t = totals.get(s.session_id) as Totals;
		const total = t.costUsd ?? 0;
		if (total === 0) continue;
		const last = s.last ?? now.toISOString();
		const rows = bySession.get(s.session_id) ?? [];
		const targets = t.byModel.filter((m) => (m.costUsd ?? 0) > 0).map((m) => ({ model: m.model, usd: m.costUsd ?? 0 }));
		const residual = total - targets.reduce((n, m) => n + m.usd, 0);
		if (Math.abs(residual) > 1e-12) {
			const top = [...targets].sort((a, b) => b.usd - a.usd)[0];
			if (top) top.usd += residual;
			else targets.push({ model: OTHER, usd: residual });
		}
		for (const target of targets) {
			const label = target.model === OTHER ? OTHER : modelLabel(target.model);
			const mine = rows.filter((r) => (r.model ?? "unknown") === target.model && r.b !== null);
			const byCost = mine.map((r) => ({ iso: bucketIso(`${r.b}`), w: r.cost ?? 0 }));
			const byTokens = mine.map((r) => ({ iso: bucketIso(`${r.b}`), w: r.i + r.o + r.cw + r.cr }));
			const weights = byCost.some((x) => x.w > 0) ? byCost : byTokens.some((x) => x.w > 0) ? byTokens : [];
			const sumW = weights.reduce((n, x) => n + x.w, 0);
			if (sumW === 0) {
				put(last, label, target.usd);
				continue;
			}
			for (const x of weights) if (x.w > 0) put(x.iso, label, (target.usd * x.w) / sumW);
		}
	}
}

/** Sessions selected by `ids` with their totals and usage grouped per model and 10-minute bucket. */
export function costInputs(db: Db, ids: { sql: string; params: unknown[] }) {
	// One pass over usage: the totals and the per-model, per-bucket groups come from the same GROUP BY.
	const groups: UsageGroup[] = [];
	const totals = totalsFor(db, ids.sql, ids.params, {
		onBucket: (b) =>
			groups.push({
				session_id: b.sessionId,
				model: b.model,
				b: b.bucket,
				i: b.inputOnly,
				o: b.output,
				cw: b.cacheWrite,
				cr: b.cacheRead,
				cost: b.cost,
			}),
	});
	const sessions = db
		.prepare(
			`SELECT session_id, repo_id, started_at, coalesce(ended_at, started_at) AS last, reported_usage
			 FROM sessions WHERE session_id IN (${ids.sql})`,
		)
		.all<{
			session_id: string;
			repo_id: string | null;
			started_at: string | null;
			last: string | null;
			reported_usage: string | null;
		}>(...ids.params);
	const bySession = new Map<string, UsageGroup[]>();
	for (const g of groups) {
		const list = bySession.get(g.session_id) ?? [];
		list.push(g);
		bySession.set(g.session_id, list);
	}
	return { totals, sessions, groups, bySession };
}

export function getCosts(db: Db, opts: { range: Range; repo?: string; now: Date; cfg: Config }): CostsResponse {
	const { totals, sessions, groups, bySession } = costInputs(db, sessionIds(opts.range, opts.now, opts.repo));

	// ---- Per day, stacked by model family ----
	const all = opts.range === "all" ? dayBuckets(null, opts.now, db) : null;
	const days = all ? all.days : rangeDays(opts.range, opts.now);
	const perDay = new Map(days.map((d) => [d, new Map<string, number>()]));
	const dayOf = new Map<string, string>();
	const toDay = (iso: string): string => {
		const key = iso.slice(0, 15);
		let day = dayOf.get(key);
		if (day === undefined) {
			day = localDate(new Date(iso.length > 15 ? iso : `${key}0:00.000Z`));
			dayOf.set(key, day);
		}
		if (perDay.has(day)) return day;
		return day < days[0] ? days[0] : (days.at(-1) as string);
	};
	// all, cut to 366 days: spend before the first shown day is reported as beforeUsd, not piled onto day one.
	let beforeUsd = 0;
	spreadCost(sessions, totals, bySession, opts.now, (iso, label, usd) => {
		if (all?.truncated && localDate(new Date(iso)) < days[0]) {
			beforeUsd += usd;
			return;
		}
		const m = perDay.get(toDay(iso)) as Map<string, number>;
		m.set(label, (m.get(label) ?? 0) + usd);
	});

	// ---- By repo ----
	const names = new Map(
		db
			.prepare("SELECT repo_id, name FROM repos")
			.all<{ repo_id: string; name: string }>()
			.map((r) => [r.repo_id, r.name]),
	);
	const repoUsd = new Map<string | null, number>();
	for (const s of sessions)
		repoUsd.set(s.repo_id, (repoUsd.get(s.repo_id) ?? 0) + (totals.get(s.session_id)?.costUsd ?? 0));
	const byRepo = [...repoUsd.entries()]
		.map(([repoId, usd]) => ({
			repoId,
			name: repoId === null ? NO_REPO : (names.get(repoId) ?? repoId),
			usd: money(usd),
		}))
		.sort(
			(a, b) => b.usd - a.usd || Number(a.repoId === null) - Number(b.repoId === null) || a.name.localeCompare(b.name),
		);

	// ---- Per model: token split and cost ----
	type ModelRow = { input: number; cacheWrite: number; cacheRead: number; output: number; usd: number | null };
	const models = new Map<string, ModelRow>();
	const row = (model: string) => {
		const r = models.get(model) ?? { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, usd: null };
		models.set(model, r);
		return r;
	};
	let input = 0;
	let cacheWrite = 0;
	let cacheRead = 0;
	let totalUsd = 0;
	let unknownModelTokens = 0;
	for (const s of sessions) {
		const t = totals.get(s.session_id) as Totals;
		input += t.input;
		cacheWrite += t.cacheWrite;
		cacheRead += t.cacheRead;
		totalUsd += t.costUsd ?? 0;
		unknownModelTokens += t.unknownTokens;
		if (t.partial) {
			for (const g of bySession.get(s.session_id) ?? []) {
				const r = row(g.model ?? "unknown");
				r.input += g.i;
				r.output += g.o;
				r.cacheWrite += g.cw;
				r.cacheRead += g.cr;
			}
		} else if (s.reported_usage) {
			const reported = JSON.parse(s.reported_usage) as Record<
				string,
				{ input?: number; output?: number; cacheRead?: number; cacheCreation?: number }
			>;
			for (const [model, m] of Object.entries(reported)) {
				const r = row(model);
				r.input += m.input ?? 0;
				r.output += m.output ?? 0;
				r.cacheWrite += m.cacheCreation ?? 0;
				r.cacheRead += m.cacheRead ?? 0;
			}
		}
		for (const m of t.byModel) if (m.costUsd !== null) row(m.model).usd = (row(m.model).usd ?? 0) + m.costUsd;
	}
	const modelRows = [...models.entries()]
		.map(([model, r]) => ({ model, label: modelLabel(model), ...r, usd: r.usd === null ? null : money(r.usd) }))
		.sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1) || a.model.localeCompare(b.model));

	// ---- Cache: hit rate over session totals, savings over usage rows at the effective table ----
	const side = input + cacheWrite + cacheRead;
	const { table } = activePricing(opts.cfg.pricing.overrides);
	const readByModel = new Map<string, number>();
	for (const g of groups) if (g.model && g.cr > 0) readByModel.set(g.model, (readByModel.get(g.model) ?? 0) + g.cr);
	let savings = 0;
	for (const [model, cr] of readByModel) {
		const p = priceOf(model, table);
		if (p) savings += (cr * (p.input - p.cacheRead)) / 1e6;
	}

	// The run rate's sessions are already loaded when the range covers the last 30 days of every repo.
	const covers = !opts.repo && (opts.range === "30d" || opts.range === "90d" || opts.range === "all");
	const from30 = new Date(opts.now.getTime() - RUN_RATE_DAYS * DAY_MS).toISOString();
	const last30Usd = covers
		? money(
				sessions
					.filter((s) => (s.started_at ?? "") >= from30)
					.reduce((n, s) => n + (totals.get(s.session_id)?.costUsd ?? 0), 0),
			)
		: lastDaysUsd(db, opts.now);
	return {
		perDay: days.map((date) => ({
			date,
			byModel: Object.fromEntries(
				[...(perDay.get(date) as Map<string, number>).entries()].map(([label, usd]) => [label, fine(usd)]),
			),
		})),
		byRepo,
		models: modelRows,
		totalUsd: money(totalUsd),
		unknownModelTokens,
		cacheHitPct: side > 0 ? Math.round((cacheRead / side) * 1000) / 10 : 0,
		cacheSavingsUsd: money(savings),
		runRate: {
			last30Usd,
			monthlyUsd: money((last30Usd / RUN_RATE_DAYS) * MONTH_DAYS),
			plans: PLAN_PRICES.plans,
			pricesAsOf: PLAN_PRICES.asOf,
		},
		truncated: all?.truncated ?? false,
		beforeUsd: money(beforeUsd),
		budget: getBudget(db, opts.cfg, opts.now),
	};
}

/** The effective table's row for a model id (family overrides included); null when it is not priced. */
function priceOf(model: string, table: Record<string, Price>): Price | null {
	const key = modelFamily(model, table);
	return key === null ? null : table[key];
}

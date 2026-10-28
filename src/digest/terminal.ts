// `cc-debrief digest` (Phase 7 P15, feature 13): spend for the last 7 or 30 days and its change against the period
// before, top repos, budget pace, spend spikes, cache hit rate and the coaching digest items, with no AI call. Text
// and Markdown follow the Recap formatter rules: "\n" endings, no trailing blank line, no prompt text, no full paths
// (repos by name only).
import { buildDigest } from "../coach/digest";
import { findSpikes } from "../coach/digest-rules/spend-spike";
import type { Config } from "../config";
import type { Db } from "../db/adapter";
import { getBudget } from "../db/queries/budget";
import { getCosts } from "../db/queries/costs";
import { localDate } from "../db/queries/range";
import { money, totalsFor } from "../db/queries/totals";
import type { BudgetState } from "../server/types";

const DAY_MS = 86_400_000;
const TOP_REPOS = 5;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export type TerminalDigest = {
	days: 7 | 30;
	/** Local date the rolling window starts on. */
	since: string;
	/** The --repo filter's name, or null for every repo. */
	repo: string | null;
	spend: { usd: number; previousUsd: number; changePct: number | null };
	sessions: number;
	cacheHitPct: number;
	topRepos: { name: string; usd: number }[];
	budget: BudgetState | null;
	spikes: { day: string; usd: number; medianUsd: number }[];
	coaching: { rule: string; severity: "low" | "medium" | "high"; message: string }[];
};

export function buildTerminalDigest(
	db: Db,
	cfg: Config,
	opts: { days: 7 | 30; repo?: string; now: Date },
): TerminalDigest {
	const { now, days } = opts;
	const range = days === 7 ? "7d" : "30d";
	const costs = getCosts(db, { range, repo: opts.repo, now, cfg });
	const from = new Date(now.getTime() - days * DAY_MS);
	const prevFrom = new Date(now.getTime() - 2 * days * DAY_MS);
	const scope = opts.repo ? " AND repo_id = ?" : "";
	const sessions =
		db
			.prepare(`SELECT count(*) AS n FROM sessions WHERE started_at >= ?${scope}`)
			.get<{ n: number }>(from.toISOString(), ...(opts.repo ? [opts.repo] : []))?.n ?? 0;
	let previousUsd = 0;
	for (const t of totalsFor(db, `SELECT session_id FROM sessions WHERE started_at >= ? AND started_at < ?${scope}`, [
		prevFrom.toISOString(),
		from.toISOString(),
		...(opts.repo ? [opts.repo] : []),
	]).values())
		previousUsd += t.costUsd ?? 0;
	previousUsd = money(previousUsd);
	const repoName = opts.repo
		? (db.prepare("SELECT name FROM repos WHERE repo_id = ?").get<{ name: string }>(opts.repo)?.name ?? opts.repo)
		: null;
	return {
		days,
		since: localDate(from),
		repo: repoName,
		spend: {
			usd: costs.totalUsd,
			previousUsd,
			changePct: previousUsd > 0 ? Math.round(((costs.totalUsd - previousUsd) / previousUsd) * 100) : null,
		},
		sessions,
		cacheHitPct: costs.cacheHitPct,
		topRepos: costs.byRepo
			.filter((r) => r.usd > 0)
			.slice(0, TOP_REPOS)
			.map((r) => ({ name: r.name, usd: r.usd })),
		budget: getBudget(db, cfg, now),
		spikes: findSpikes(db, now, days).map((s) => ({ day: s.day, usd: s.usd, medianUsd: s.median })),
		coaching: buildDigest(db, { range, repo: opts.repo, now, cfg }).items.map((i) => ({
			rule: i.rule,
			severity: i.severity,
			message: i.message,
		})),
	};
}

const usd = (n: number) => `$${n.toFixed(2)}`;
const dayLabel = (day: string) => {
	const [y, m, d] = day.split("-").map(Number);
	return `${WEEKDAYS[new Date(y, m - 1, d).getDay()]} ${MONTHS[m - 1]} ${d}`;
};

function title(d: TerminalDigest): string {
	return `Claude Code digest${d.repo ? ` for ${d.repo}` : ""} · last ${d.days} days (since ${d.since})`;
}
function spendLine(d: TerminalDigest): string {
	const change =
		d.spend.changePct === null
			? `no spend the ${d.days} days before`
			: `${d.spend.changePct >= 0 ? "+" : "−"}${Math.abs(d.spend.changePct)}% vs the ${d.days} days before`;
	return `${usd(d.spend.usd)} · ${change} · ${d.sessions} ${d.sessions === 1 ? "session" : "sessions"}`;
}
function budgetLine(b: BudgetState): string {
	const over = b.level === "over" ? `, over the ${usd(b.budgetUsd)} budget` : "";
	return `${usd(b.monthToDateUsd)} of ${usd(b.budgetUsd)} this month · on pace for ${usd(b.projectedUsd)}${over} · ${b.daysLeft} ${b.daysLeft === 1 ? "day" : "days"} left`;
}
const spikeLine = (s: TerminalDigest["spikes"][number]) =>
	`${dayLabel(s.day)} ${usd(s.usd)} (usual ${usd(s.medianUsd)})`;

export function formatDigestText(d: TerminalDigest): string {
	const lines = [title(d), `Spend: ${spendLine(d)}`, `Cache hit: ${d.cacheHitPct.toFixed(1)}%`];
	if (d.budget) lines.push(`Budget: ${budgetLine(d.budget)}`);
	if (d.topRepos.length > 0) {
		const width = Math.max(...d.topRepos.map((r) => r.name.length));
		lines.push("Top repos:", ...d.topRepos.map((r) => `  ${r.name.padEnd(width)}  ${usd(r.usd)}`));
	} else lines.push("Top repos: none");
	if (d.spikes.length > 0) lines.push("Spikes:", ...d.spikes.map((s) => `  ${spikeLine(s)}`));
	else lines.push("Spikes: none");
	if (d.coaching.length > 0) lines.push("Coaching:", ...d.coaching.map((c) => `  - [${c.severity}] ${c.message}`));
	else lines.push("Coaching: nothing to report");
	return lines.join("\n");
}

export function formatDigestMarkdown(d: TerminalDigest): string {
	const lines = [`## ${title(d)}`, "", `- **Spend:** ${spendLine(d)}`, `- **Cache hit:** ${d.cacheHitPct.toFixed(1)}%`];
	if (d.budget) lines.push(`- **Budget:** ${budgetLine(d.budget)}`);
	const section = (head: string, items: string[], none: string) =>
		lines.push("", `### ${head}`, "", ...(items.length > 0 ? items.map((i) => `- ${i}`) : [none]));
	section(
		"Top repos",
		d.topRepos.map((r) => `${r.name}: ${usd(r.usd)}`),
		"None.",
	);
	section("Spikes", d.spikes.map(spikeLine), "None.");
	section(
		"Coaching",
		d.coaching.map((c) => `**${c.severity}** ${c.message}`),
		"Nothing to report.",
	);
	return lines.join("\n");
}

// "Polish with AI" (feature 17; Phase 6 spec decision 4): the only claude -p call of the recap. One runClaude call
// with feature "recap", the deterministic recap as JSON (repo labels, bullets, base-name files, stored AI summaries),
// no prompts, no transcript, no --resume, no daily cap, no retry. The result is validated and never stored.
import { z } from "zod";
import { ClaudeError, runClaude } from "../claude/headless";
import { estimateCost } from "../collector/prices";
import { priceableModel } from "../collector/summarize";
import type { Config } from "../config";
import type { Db } from "../db/adapter";
import { baseNamePaths } from "./build";
import type { PolishedRecap, Recap, RecapGroup } from "./types";

export const POLISH_TIMEOUT_MS = 120_000;
const OUTPUT_TOKENS = 600;
const MEAN_OF = 10;
const MEAN_FROM = 3;
const RECENT_USAGE = 2000;

export const POLISH_SCHEMA = {
	type: "object",
	properties: {
		groups: {
			type: "array",
			items: {
				type: "object",
				properties: { repo: { type: "string" }, items: { type: "array", items: { type: "string" } } },
				required: ["repo", "items"],
				additionalProperties: false,
			},
		},
	},
	required: ["groups"],
	additionalProperties: false,
} as const;

const PolishSchema = z.object({ groups: z.array(z.object({ repo: z.string(), items: z.array(z.string()) })) });

/** A failed polish; `reason` is a runClaude reason (exit, timeout, …) or "schema". The original recap stays. */
export class PolishError extends Error {
	constructor(
		readonly reason: string,
		message = `polish failed: ${reason}`,
	) {
		super(message);
		this.name = "PolishError";
	}
}

const INSTRUCTIONS = `You turn a developer's work log into a short standup update.
The JSON below lists, per repo, what they worked on: one bullet per session, the files they edited, and an AI
summary of the session when one exists. Write a concise list of items per repo in the past tense ("Added …",
"Fixed …"). Merge related items into one. Do not invent work that is not in the input. Use only the repo labels
given in the input, spelled exactly as given; leave out a repo only if it has nothing worth saying. Answer with the
JSON schema you were given.`;

/** Repo groups of a recap, days merged (busiest first, ties by name). */
function repoGroups(r: Recap): RecapGroup[] {
	if (r.groupBy === "repo") return r.groups;
	const merged = new Map<string, RecapGroup>();
	for (const d of r.days)
		for (const g of d.groups) {
			const m = merged.get(g.repo);
			if (m) {
				m.turns += g.turns;
				m.bullets.push(...g.bullets);
			} else merged.set(g.repo, { ...g, bullets: [...g.bullets] });
		}
	return [...merged.values()].sort((a, b) => b.turns - a.turns || a.repo.localeCompare(b.repo));
}

/** The fixed instructions plus the recap as JSON. Hidden repos are already out of the recap. */
export function polishPrompt(db: Db, r: Recap): string {
	const groups = repoGroups(r);
	const ids = groups.flatMap((g) => g.bullets.flatMap((b) => b.sessionIds));
	const stored = new Map(
		db
			.prepare(
				`SELECT session_id AS id, summary FROM sessions
				 WHERE session_id IN (SELECT value FROM json_each(?)) AND summary IS NOT NULL`,
			)
			.all<{ id: string; summary: string }>(JSON.stringify([...new Set(ids)]))
			.map((s) => [s.id, baseNamePaths(s.summary.replace(/\s+/g, " ").trim())]),
	);
	const repos = groups.map((g) => ({
		repo: g.repo,
		bullets: g.bullets.map((b) => {
			const summaries = [...new Set(b.sessionIds.map((id) => stored.get(id)).filter((s): s is string => !!s))];
			return { text: b.text, files: b.files, ...(summaries.length ? { summaries } : {}) };
		}),
	}));
	return `${INSTRUCTIONS}\n\n${JSON.stringify({ repos }, null, 2)}`;
}

const bulletCount = (r: Recap) => repoGroups(r).reduce((n, g) => n + g.bullets.length, 0);

/** One claude -p call; throws PolishError on any failure, with no second call. An empty recap makes no call. */
export async function polishRecap(
	db: Db,
	recap: Recap,
	cfg: Config,
	opts: { timeoutMs?: number } = {},
): Promise<PolishedRecap> {
	if (bulletCount(recap) === 0) return { range: recap.range, groups: [], costUsd: 0 };
	let call: Awaited<ReturnType<typeof runClaude<unknown>>>;
	try {
		call = await runClaude<unknown>({
			prompt: polishPrompt(db, recap),
			schema: POLISH_SCHEMA,
			feature: "recap",
			model: cfg.ai.model,
			timeoutMs: opts.timeoutMs ?? POLISH_TIMEOUT_MS,
			db,
		});
	} catch (e) {
		if (e instanceof ClaudeError) throw new PolishError(e.reason);
		throw e;
	}
	const parsed = PolishSchema.safeParse(call.result);
	if (!parsed.success) throw new PolishError("schema");
	const labels = new Set(repoGroups(recap).map((g) => g.repo));
	if (parsed.data.groups.some((g) => !labels.has(g.repo))) throw new PolishError("schema");
	const groups = parsed.data.groups
		.map((g) => ({ repo: g.repo, items: g.items.map((i) => i.replace(/\s+/g, " ").trim()).filter(Boolean) }))
		.filter((g) => g.items.length > 0);
	if (groups.length === 0) throw new PolishError("schema");
	return { range: recap.range, groups, costUsd: call.costUsd, ...(call.model ? { model: call.model } : {}) };
}

/**
 * Estimated polish cost (feature 17 "Polish" 5): the mean cost of the last 10 recap calls once there are 3, else the
 * prompt's chars / 4 plus 600 output tokens on ai.model or the most-used model; null when nothing can be priced.
 */
export function estimatePolishCost(db: Db, recap: Recap, cfg: Config): number | null {
	const costs = db
		.prepare("SELECT cost_usd AS usd FROM self_usage WHERE feature = 'recap' ORDER BY ts DESC, id DESC LIMIT ?")
		.all<{ usd: number | null }>(MEAN_OF)
		.map((r) => r.usd)
		.filter((u): u is number => u !== null);
	if (costs.length >= MEAN_FROM) return costs.reduce((a, b) => a + b, 0) / costs.length;
	// The most-used model of the newest usage rows (by rowid): a full GROUP BY over usage cost ~0.5 s on 10k sessions.
	const model =
		cfg.ai.model ??
		db
			.prepare(
				`SELECT model FROM (SELECT model FROM usage WHERE model IS NOT NULL ORDER BY id DESC LIMIT ${RECENT_USAGE})
				 GROUP BY model ORDER BY count(*) DESC LIMIT 1`,
			)
			.get<{ model: string }>()?.model;
	if (!model) return null;
	return estimateCost({
		model: priceableModel(model),
		inputTokens: Math.ceil(polishPrompt(db, recap).length / 4),
		outputTokens: OUTPUT_TOKENS,
		cacheCreationTokens: 0,
		cacheCreation1hTokens: 0,
		cacheReadTokens: 0,
	});
}

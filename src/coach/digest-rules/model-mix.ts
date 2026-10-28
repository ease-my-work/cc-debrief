// Digest rule 4, model mix (feature 09): exploration sessions on the most expensive model used in the last 7 days.
import { modelFamily, modelLabel, PRICE_TABLE } from "../../collector/prices";
import type { DigestRule } from "../types";
import { costTokensSql, daysBefore } from "./shared";

export const modelMix: DigestRule = {
	rule: "model_mix",
	run(db, now) {
		const rows = db
			.prepare(
				`SELECT u.session_id, u.model, u.cost_usd,
				   ${costTokensSql("u.")} AS tokens, s.session_type
				 FROM usage u JOIN sessions s ON s.session_id = u.session_id WHERE u.ts >= ?`,
			)
			.all<{
				session_id: string;
				model: string | null;
				cost_usd: number | null;
				tokens: number;
				session_type: string | null;
			}>(daysBefore(now, 7));
		// Most expensive = highest PRICE_TABLE input price (output breaks a tie); unknown models are left out.
		let top: { family: string; input: number; output: number } | null = null;
		for (const r of rows) {
			const family = r.model ? modelFamily(r.model) : null;
			if (!family) continue;
			const p = PRICE_TABLE[family];
			if (!top || p.input > top.input || (p.input === top.input && p.output > top.output)) {
				top = { family, input: p.input, output: p.output };
			}
		}
		if (!top) return [];
		const family = top.family;
		const explorationOnTop = new Set(
			rows
				.filter((r) => r.session_type === "exploration" && r.model && modelFamily(r.model) === family)
				.map((r) => r.session_id),
		);
		if (explorationOnTop.size === 0) return [];
		const totalCost = rows.reduce((n, r) => n + (r.cost_usd ?? 0), 0);
		let cost = 0;
		let tokens = 0;
		for (const r of rows) {
			if (!explorationOnTop.has(r.session_id)) continue;
			cost += r.cost_usd ?? 0;
			tokens += r.tokens;
		}
		const pct = totalCost > 0 ? Math.round((cost / totalCost) * 100) : 0;
		const count = explorationOnTop.size;
		return [
			{
				rule: this.rule,
				severity: "low",
				message: `${count} exploration ${count === 1 ? "session" : "sessions"} on ${modelLabel(family)} = ${pct}% of cost`,
				evidence: { key: family, model: family, count, pct, sessions: [...explorationOnTop].sort() },
				costTokens: tokens,
				target: "session",
			},
		];
	},
};

// Digest rule 1, unused skill (feature 09): loaded in ≥ 80% of sessions and never invoked over 30 days.
import { estimateContextTokens } from "../../collector/inventory";
import type { DigestRule, Finding } from "../types";
import { daysBefore, presentItems, scopeSessionsSql } from "./shared";

const MIN_LOADED_SHARE = 0.8;

export const unusedSkill: DigestRule = {
	rule: "unused_skill",
	run(db, now) {
		const since = daysBefore(now, 30);
		const out: Finding[] = [];
		for (const item of presentItems(db, "skill")) {
			const scope = scopeSessionsSql(item);
			const sessions =
				db
					.prepare(`SELECT count(*) AS n FROM sessions s WHERE ${scope.where}`)
					.get<{ n: number }>(since, ...scope.params)?.n ?? 0;
			if (sessions === 0) continue;
			const use = db
				.prepare(
					`SELECT coalesce(sum(u.loaded), 0) AS loaded, coalesce(sum(u.invoked), 0) AS invoked
					 FROM inventory_usage u JOIN sessions s ON s.session_id = u.session_id
					 WHERE u.inventory_id = ? AND ${scope.where}`,
				)
				.get<{ loaded: number; invoked: number }>(item.id, since, ...scope.params) ?? { loaded: 0, invoked: 0 };
			if (use.invoked > 0 || use.loaded / sessions < MIN_LOADED_SHARE) continue;
			const perSession = estimateContextTokens(item.description);
			out.push({
				rule: this.rule,
				severity: "low",
				message: `\`${item.name}\` loaded in ${use.loaded} of ${sessions} sessions, never invoked · ~${perSession} tokens per session`,
				evidence: {
					key: String(item.id),
					skill: item.name,
					loaded: use.loaded,
					sessions,
					tokensPerSession: perSession,
					repoId: item.scope === "repo" ? item.repo_id : null,
				},
				costTokens: perSession * use.loaded,
				target: "skills",
			});
		}
		return out;
	},
};

// Cross-repo repeats (feature 10 "Cross-repo repeats"): label and fingerprint edges across every repo's sessions; a
// component spanning ≥ 2 repos with ≥ 3 sessions (over the cost floor) is a user_skill pattern with repo_id NULL.
// Sessions without a repo join only by label.
import type { Db } from "../db/adapter";
import { type Candidate, qualifies } from "./candidate";
import { loadDetectSessions, pickLabel, syncCandidates } from "./detect";
import { fingerprintText } from "./fingerprint";
import { buildGraph, components } from "./graph";

/** Sessions compared across repos (a larger cap than one repo's 500). */
export const CROSS_REPO_MAX_SESSIONS = 1000;
const MIN_REPOS = 2;

export function crossRepoCandidates(db: Db, now: Date): Candidate[] {
	const sessions = loadDetectSessions(db, { sql: "1 = 1", params: [] }, now, CROSS_REPO_MAX_SESSIONS);
	const edges = buildGraph(
		sessions.map((s) => ({
			id: s.id,
			label: s.labelNorm,
			// No repo: no fingerprint edge (label only).
			trigrams: s.repoId === null ? new Set<string>() : s.trigrams,
			firstPrompt: s.prompts[0] ?? "",
		})),
	);
	const out: Candidate[] = [];
	for (const comp of components(sessions.length, edges)) {
		const members = comp.map((i) => sessions[i]);
		const repos = new Set(members.map((s) => s.repoId).filter((r): r is string => r !== null));
		if (repos.size < MIN_REPOS || !qualifies(members)) continue;
		const picked = pickLabel(members);
		if (!picked) continue;
		const newest = [...members].reverse().find((s) => s.trigrams.size > 0);
		out.push({
			kind: "user_skill",
			...picked,
			sessions: members,
			fingerprint: newest ? fingerprintText(newest.steps) : null,
			meta: {},
		});
	}
	return out;
}

/** Writes the cross-repo user_skill candidates (scope repo_id NULL) and their findings. */
export function crossRepoPatterns(db: Db, now: Date = new Date()): { created: number; updated: number } {
	return syncCandidates(db, null, ["user_skill"], crossRepoCandidates(db, now), now);
}

// What detection reads per session and the candidates it builds (feature 10), shared by detect, classify and crossrepo.
import { DIGEST_COST_FLOOR_TOKENS } from "../coach/digest";
import type { PatternKind, PatternMeta } from "../db/queries/patterns";
import type { Step } from "./fingerprint";

export const MIN_SESSIONS = 3;

export type DetectSession = {
	id: string;
	repoId: string | null;
	startedAt: string;
	endedAt: string | null;
	sessionType: string | null;
	/** Non-cached tokens (input + cache creation + output), as every finding cost (Phase 4 tuning). */
	tokens: number;
	/** The newest review's task_pattern and its normalized form. */
	label: string | null;
	labelNorm: string | null;
	steps: Step[];
	trigrams: Set<string>;
	/** User prompts in turn order; [0] is the first prompt. */
	prompts: string[];
	/** Paths of file_changes rows. */
	edits: string[];
	/** Files Read among the first five tool calls. */
	earlyReads: string[];
};

export type Candidate = {
	kind: PatternKind;
	label: string;
	labelNorm: string;
	/** Oldest first. */
	sessions: DetectSession[];
	fingerprint: string | null;
	meta: PatternMeta;
};

export const sumTokens = (ss: DetectSession[]): number => ss.reduce((n, s) => n + s.tokens, 0);

/** Feature 10 step 3: ≥ 3 sessions whose tokens reach the digest cost floor. */
export const qualifies = (ss: DetectSession[]): boolean =>
	ss.length >= MIN_SESSIONS && sumTokens(ss) >= DIGEST_COST_FLOOR_TOKENS;

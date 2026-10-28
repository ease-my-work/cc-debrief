// Every dashboard API request and response type (feature 12). Imported by src/server/routes/* and
// ui/src/api.ts so the two sides cannot drift. Phase 4+ fields are typed now and are null / [] / absent in Phase 2.
import type { Config } from "../config";

export type { Config };

export type Range = "today" | "7d" | "30d" | "90d" | "all"; // all = everything still retained (Phase 7)
export type Surface = "cli" | "vscode" | "desktop" | "unknown";
export type SessionType = "feature" | "bugfix" | "refactor" | "exploration" | "ops" | "docs" | "other";
export type InventoryKind =
	| "skill"
	| "mcp"
	| "plugin"
	| "hook"
	// Phase 7 P11 (migration 009)
	| "agent"
	| "command"
	| "output_style"
	| "rule"
	| "workflow";
export type InventoryStatus = "active" | "unused_30d" | "never_used";

export type ApiError = { error: { code: string; message: string } };

// ---- Requests (query strings, already parsed) ----

export type OverviewQuery = { range?: Range; repo?: string };
export type ListSessionsQuery = {
	range?: Range;
	repo?: string;
	type?: SessionType;
	q?: string;
	cursor?: string; // opaque: base64 of `started_at|session_id`
	limit?: number; // ≤ 100
};
export type InventoryQuery = { kind?: InventoryKind; range?: Range; repo?: string; unused?: boolean };
export type ToolsQuery = { range?: Range; repo?: string };
export type ReposQuery = { range?: Range };

// ---- GET /api/status ----

export type JobProgress = { done: number; total: number };
export type StatusResponse = {
	ai: { summaries: boolean; reviews: boolean; autoReview: boolean; drafts: boolean };
	lastIngestAt: string | null;
	lastHookEventAt: string | null;
	hooksInstalled: boolean;
	backfill: JobProgress | null;
	summaryJob: JobProgress | null; // Phase 3
	reviewJob: JobProgress | null; // Phase 5a
	tier1Job: JobProgress | null; // Phase 4
	inProgressSessions: number;
	pollSeconds: number;
	pendingSummaries: number;
	pendingImportedSummaries: number;
	version: string;
};

// ---- Sessions ----

export type SessionListItem = {
	id: string;
	startedAt: string;
	endedAt: string | null;
	surface: Surface;
	repo: { id: string; name: string } | null;
	type: SessionType | null;
	typeSource: "ai" | "heuristic" | null;
	summaryLine: string | null; // sessions.title, else first sentence of summary, else first prompt line (≤ 120 chars)
	tokens: number;
	costUsd: number | null;
	partial: boolean; // counted total (no cost-state line): shown as "at least" (feature 02)
	tokensUnknown: boolean; // no usage rows: the UI shows "tokens unknown", not 0 (feature 02)
	durationSec: number | null;
	models: string[];
	/** Phase 5a: null while reviews are off; estUsd only for an eligible row ("Review (~$)"). */
	review: { state: "none" | "eligible" | "reviewed"; estUsd: number | null } | null;
	inProgress: boolean; // no SessionEnd event and last line < 30 min old
	imported: boolean; // capture 'backfill'
};

export type SessionsResponse = { items: SessionListItem[]; total: number; nextCursor: string | null };

export type ReviewBand = {
	state: "disabled" | "not_reviewed" | "running" | "reviewed";
	/** The click's estimate ("Review this session (~$)", "Review again (~$)"); null when unknown or reviews are off. */
	estUsd: number | null;
	/** Today's review cap is used up: the button is disabled with "daily cap reached". */
	capReached: boolean;
	findings: {
		id: number;
		rule: string;
		label: string;
		severity: "low" | "medium" | "high";
		message: string;
		turns: number[];
		costTokens: number;
		collapsed: boolean;
		feedback: "helpful" | "not_helpful" | null;
	}[];
	tier2: {
		betterApproach: string;
		whatWentWell: string;
		suggestedFirstPrompt: string;
		confidence: "low" | "medium" | "high";
		costUsd: number | null;
		model: string | null;
		/** "Was this useful?" on the review (reviews.feedback). */
		feedback: "helpful" | "not_helpful" | null;
	} | null;
	dismissedUntil: string | null;
	permissionPrompts: "recorded" | "not_recorded"; // Phase 4; not_recorded for imported sessions
	nudgeDismissed: boolean; // Phase 4: the band's reviews nudge (meta nudge.session.dismissed_at)
};

/**
 * A skill, MCP server or tool the session used: its tool calls (subagents' included) and failures (ok = 0 and not
 * denied, feature 03). A skill run only as a slash command has 0 calls.
 */
export type UsedItem = { name: string; calls: number; failures: number };

// The list item's `tokens` (a total, with `tokensUnknown`) and `review` (a list badge) are replaced by the detail's
// richer shapes.
export type SessionDetail = Omit<SessionListItem, "tokens" | "tokensUnknown" | "review"> & {
	cwd: string;
	startReason: string | null;
	permissionMode: string | null;
	summary: string | null;
	outcome: "completed" | "partial" | "abandoned" | "unclear" | null;
	tags: string[];
	summaryState: "done" | "pending" | "skipped" | "error" | "disabled"; // skipped: fewer than 2 turns
	summaryError: string | null;
	summaryEstUsd: number | null; // Phase 3: the Summarize button's "~$0.02"
	summaryCapReached: boolean; // Phase 3: today's summary cap is used up
	resumeCommand: string; // "claude --resume <session_id>"
	tokens: {
		input: number;
		cacheWrite: number;
		cacheRead: number;
		output: number;
		costUsd: number | null;
		byModel: { model: string; tokens: number; costUsd: number | null }[];
		unknown: boolean; // no usage rows: the UI shows "tokens unknown", not 0
	};
	turns: {
		seq: number;
		startedAt: string;
		userText: string;
		assistantExcerpt: string | null; // ≤ 300 chars
		tools: { label: string; count: number; totalMs: number | null; failures: number; denials: number }[];
	}[];
	toolCallCount: number;
	/** Per repo and path; `repo` is the repo's name, null outside a repo. */
	files: { path: string; repo: string | null; added: number; removed: number; language: string | null }[];
	used: {
		skills: UsedItem[];
		mcpServers: UsedItem[];
		tools: UsedItem[]; // built-in tools (no MCP server), Skill and Agent included
		instructionFiles: { path: string; kind: string | null; count: number }[];
	};
	subagents: {
		agentId: string;
		agentType: string | null;
		description: string | null;
		turnSeq: number | null;
		toolCalls: number;
	}[];
	compactions: { ts: string; trigger: string | null; afterTurnSeq: number | null }[];
	review: ReviewBand | null; // Phase 4-5; null before
};

// ---- GET /api/sessions/:id/replay (Phase 7 P8) ----

export type ReplayTurn = {
	seq: number;
	startedAt: string | null;
	userText: string;
	/** The full stored reply (≤ 32 KB); truncated when derive cut it. */
	assistantText: string;
	truncated: boolean;
	tokens: { input: number; cacheWrite: number; cacheRead: number; output: number };
	costUsd: number | null;
	tools: { label: string; count: number; failures: number }[];
	failures: number;
	/** A compaction happened since the turn before. */
	compaction: boolean;
};
/** cumulative[i]: tokens of turns 0..i. */
export type ReplayResponse = { turns: ReplayTurn[]; cumulative: number[] };

// ---- GET /api/overview ----

export type Overview = {
	tiles: {
		sessions: {
			total: number;
			bySurface: Record<Surface, number>;
			/** Phase 7 P13 donut: top 6 repos by sessions, then "other" (repoId null); "no repo" for sessions outside one. */
			byRepo: { repoId: string | null; name: string; sessions: number }[];
		};
		tokens: { total: number; cacheServedPct: number };
		cost: { usd: number; byModel: { model: string; label: string; usd: number }[]; unknownModelTokens: number };
		lines: { added: number; removed: number; files: number; repos: number };
	};
	tokensPerDay: { date: string; input: number; cacheRead: number; output: number }[]; // input includes cache writes
	chartNote: string | null; // Phase 4 (cache_hit_dip finding); null before
	recent: SessionListItem[]; // last 5
	budget: BudgetState | null; // Phase 7 P4; null when budget.monthlyUsd is off
};

// ---- GET /api/activity (Phase 7 P2, feature 18) ----

export type ActivityResponse = {
	/** The last 365 local days (U4), oldest first; retained false before the oldest retained session's day. */
	days: { date: string; sessions: number; tokens: number; retained: boolean }[];
	/** Over every retained day; current ends today, or yesterday while today has no session yet. */
	streak: { current: number; longest: number };
	/** The rest follows the range. */
	activeDays: number;
	byHour: number[]; // 24, local time
	byWeekday: number[]; // 7, Sunday = 0
	compactedShare: number;
	sessions: number;
	/** range all: retained sessions are older than the heatmap. */
	truncated: boolean;
};

// ---- GET /api/tasks-plans (Phase 7 P12) ----

export type TaskStatus = "pending" | "in_progress" | "completed";
export type TasksPlansResponse = {
	/** Newest state per task, most recently updated first; repo is the repo's name. */
	tasks: { subject: string; status: string; sessionId: string; repo: string | null; updatedAt: string }[];
	/** ExitPlanMode plans (Markdown), newest first. */
	plans: { sessionId: string; repo: string | null; ts: string; plan: string }[];
};

// ---- Monthly budget (Phase 7 P4, feature 18): on Overview and Costs ----

export type BudgetState = {
	budgetUsd: number;
	monthToDateUsd: number;
	projectedUsd: number;
	/** warn: projected ≥ 80% of the budget; over: ≥ 100% (U2). */
	level: "ok" | "warn" | "over";
	daysLeft: number;
};

// ---- GET /api/costs (Phase 7 P3 + P6, feature 18) ----

export type CostsResponse = {
	/** Local days of the range (all: the newest 366), USD by model family label. */
	perDay: { date: string; byModel: Record<string, number> }[];
	byRepo: { repoId: string | null; name: string; usd: number }[];
	/** usd null: a model not in the effective price table (its tokens are counted, never priced). */
	models: {
		model: string;
		label: string;
		input: number;
		cacheWrite: number;
		cacheRead: number;
		output: number;
		usd: number | null;
	}[];
	totalUsd: number;
	unknownModelTokens: number;
	cacheHitPct: number;
	cacheSavingsUsd: number;
	/** The last 30 days whatever the range or repo, as a monthly figure, next to the plan prices (information only). */
	runRate: { last30Usd: number; monthlyUsd: number; plans: { name: string; usd: number }[]; pricesAsOf: string };
	truncated: boolean;
	/** With truncated: spend before the first shown day (left off the chart); 0 otherwise. */
	beforeUsd: number;
	budget: BudgetState | null;
};

// ---- GET /api/inventory, GET /api/tools ----

export type InventoryItemRow = {
	id: number;
	name: string;
	source: string; // plugin name, "user", or "<repo name>/.claude/skills"
	scope: "user" | "plugin" | "repo";
	path: string;
	sessionsLoaded: number;
	sessionsInvoked: number;
	lastUsed: string | null;
	ctxTokens: number;
	status: InventoryStatus;
	removed: boolean; // not found by the latest scan of its scope; history kept
	provides?: string; // plugins: "4 skills"; hooks: the event
	enabled?: boolean | null; // plugins
	tools?: number; // mcp extras
	calls?: number;
	failures?: number;
	medianMs?: number;
	/** Phase 7 P11: false for output styles, rules and workflows (no invocation record; shown as "usage not recorded"). */
	usageRecorded?: boolean;
};

export type InventoryResponse = {
	strip: {
		installed: number;
		byScope: { user: number; plugin: number; repo: number };
		invoked: number;
		neverInvoked: number;
		unusedCtxTokensPerSession: number;
	};
	items: InventoryItemRow[];
	proposed?: ProposedSkill[]; // kind=skill, Phase 5b
};

export type ToolStat = {
	name: string;
	calls: number;
	failures: number; // ok = 0 and not denied (feature 03)
	denials: number;
	medianMs: number | null;
	sessions: number;
	lastUsed: string | null;
	category: ToolCategory; // Phase 7 P10
};
export type ToolsResponse = { tools: ToolStat[] };

// ---- Phase 7 P10: feature adoption and Claude Code versions ----

import type { ToolCategory } from "../derive/tool-categories";

export type { ToolCategory };
export type AdoptionRow = {
	feature: "plan_mode" | "subagents" | "skills" | "mcp" | "web" | "auto_mode";
	sessions: number;
	/** Of sessions started in the range (0 when there are none). */
	share: number;
};
export type VersionRow = { version: string; firstSeen: string; lastSeen: string; sessions: number };
export type AdoptionResponse = { rows: AdoptionRow[] };
export type VersionsResponse = { versions: VersionRow[] };

// ---- GET /api/repos, GET /api/repos/:id ----

export type RepoRow = {
	id: string;
	name: string;
	remoteUrl: string | null;
	branch: string | null;
	branchesSeen: number;
	sessions: number;
	tokens: number;
	costUsd: number;
	linesAdded: number;
	linesRemoved: number;
	repoSkillsUsed: number;
	repoSkillsAvailable: number;
	repoMcp: string[];
};
export type ReposResponse = { repos: RepoRow[] };

export type RepoDetail = {
	repo: RepoRow;
	files: { path: string; sessions: number; added: number; removed: number }[]; // top 5
	typeMix: { type: SessionType; pct: number }[]; // empty until Phase 3
	items: {
		kind: "skill" | "mcp" | "instructions";
		name: string;
		source: string;
		lazy: boolean;
		tools?: number;
		invoked?: number;
		calls?: number;
		loaded?: number;
		used: boolean;
	}[];
	suggestions: PatternRow[]; // Phase 5b; [] before
	/** Phase 7 P9: lines changed per language, sessions per branch, what the sessions used, weekly trend. */
	languages: { language: string; lines: number }[];
	branches: { name: string; sessions: number }[];
	used: {
		skills: { name: string; count: number }[];
		mcpServers: { name: string; count: number }[];
		agentTypes: { name: string; count: number }[];
	};
	topTools: { name: string; calls: number }[];
	/** Weeks start Monday (local), oldest first, empty weeks included. */
	perWeek: { week: string; sessions: number; usd: number }[];
};

/** GET /api/repos/:id/memory (Phase 7 P12): the repo's auto-memory files, read live. */
export type MemoryFile = { name: string; size: number; mtime: string; truncated: boolean };
export type MemoryListResponse = { files: MemoryFile[] };
export type MemoryFileResponse = { name: string; text: string; truncated: boolean };

// ---- Self-usage (feature 15): GET /api/self-usage, the digest footer line ----

export type AiFeature = "summary" | "review" | "draft" | "recap";
/** Percent of user + self USD; rounded to 2 decimals, null when both are 0. The UI applies feature 15's display rules. */
export type SelfUsage = {
	range: "7d" | "30d";
	byFeature: {
		feature: AiFeature;
		calls: number;
		failed: number;
		tokens: number;
		cacheReadTokens: number;
		usd: number;
		sharePct: number | null;
	}[];
	total: { calls: number; failed: number; tokens: number; usd: number; sharePct: number | null };
	userUsd: number;
};
export type SelfUsageLine = {
	summaries: number;
	reviews: number;
	drafts: number;
	recaps: number;
	tokens: number;
	usd: number;
	sharePct: number | null;
};

// ---- Summaries (feature 06; Phase 3 spec decision 1) ----

export type SummarizeResponse = {
	status: "done" | "skipped" | "capped" | "error";
	costUsd: number | null;
	reason: string | null;
};
export type SummaryEstimate = { sessions: number; estUsd: number | null; capRemainingToday: number };
export type SummaryRunResponse = { queued: number };

// ---- Settings (feature 16): GET/PUT /api/config ----

export type ConfigIssue = { key: string; message: string };
export type ConfigResponse = {
	config: Config;
	defaults: Config;
	explicit: string[];
	path: string;
	errors: ConfigIssue[];
	defaultRedactCount: number;
	demotedRules: { rule: string; notHelpful: number; demotedAt: string }[]; // Phase 4; [] before
	usedToday: { summaries: number; reviews: number };
	pendingSummaries: number;
	/** Per-call cost notes: the feature's recent average, else a price-table estimate; null when unknown. */
	estimates: { summaryUsd: number | null; reviewUsd: number | null; draftUsd: number | null };
	dataDir: string;
	dbBytes: number;
	/** Phase 7 P11: size of ~/.claude/projects (Claude Code's transcripts); projectsCut: the 2 s walk stopped early. */
	storage: { projectsBytes: number; projectsCut: boolean };
	/** Phase 7 P7: the built-in table, the effective version (with overrides) and the re-price job. */
	pricing: {
		tableVersion: string;
		effectiveVersion: string;
		builtIn: {
			model: string;
			input: number;
			output: number;
			cacheWrite: number;
			cacheWrite1h: number;
			cacheRead: number;
		}[];
		repricing: JobProgress | null;
	};
};
export type ConfigPatch = { set?: Record<string, unknown>; unset?: string[] };
export type ConfigUpdateResponse = { config: Config; changed: string[] };
export type ConfigUpdateError = { error: { code: "invalid_config"; message: string; fields: ConfigIssue[] } };
export type RetentionPreview = { sessions: number };

// ---- Coaching digest (feature 09): GET /api/improvements. Phase 3 ships the footer; items arrive in Phase 4 ----

export type DigestItem = {
	id: number;
	rule: string;
	severity: "low" | "medium" | "high";
	message: string;
	costTokens: number;
	sessionCount: number;
	repoId: string | null;
	target: "session" | "skills" | "repos" | "overview";
	href: string;
	demoted: boolean;
	collapsed: boolean;
	/** The vote on the item's group (feedback applies to the whole group), so the buttons show it. */
	feedback: "helpful" | "not_helpful" | null;
	action: { kind: "draft"; patternId: number; estUsd: number | null } | null;
};
export type DigestFooter = {
	reviewsThisWeek: number;
	reviewCostUsd: number;
	dismissed: number;
	eligibleUnreviewed: number;
	/** Sum of the eligible sessions' estimates; null when any is unknown ("cost unknown"). */
	estReviewAllUsd: number | null;
	reviewsEnabled: boolean;
	nudgeDismissed: boolean;
	selfUsage: SelfUsageLine;
};
export type ImprovementsResponse = { items: DigestItem[]; footer: DigestFooter };

// ---- Tier 2 reviews (Phase 5a spec decisions 2, 3, 6) ----

/** POST /api/sessions/:id/review on success; errors are 409 / 429 / 502 with { error: { code, message } }. */
export type ReviewResponse = { reviewId: number; costUsd: number | null; band: ReviewBand };
/** POST /api/reviews/run { scope: "eligible_7d" }. */
export type ReviewRunResponse = { queued: number; estUsd: number | null };
/** POST /api/sessions/:id/review/feedback { value }: the rules that are now demoted. */
export type ReviewFeedbackResponse = { demoted: string[] };

// ---- Findings (features 07, 09): GET /api/findings (Phase 4 spec decision 9) ----

export type FindingRow = {
	id: number;
	sessionId: string | null;
	rule: string;
	label: string;
	severity: "low" | "medium" | "high";
	message: string;
	evidence: Record<string, unknown>;
	costTokens: number;
	createdAt: string;
	dismissedUntil: string | null;
	feedback: "helpful" | "not_helpful" | null;
	demoted: boolean;
	repoId: string | null;
};
export type FindingsQuery = { range?: Range; repo?: string; session?: string };
export type FindingsResponse = { findings: FindingRow[] };
// POST /api/findings/:id/feedback, POST /api/findings/:id/dismiss (scope "session": all of that finding's session's
// findings, the band's "Dismiss 30d"), POST /api/findings/rules/:rule/enable → { ok: true }.
export type FeedbackRequest = { value: "helpful" | "not_helpful" };
export type FeedbackResponse = { ok: true; demoted: boolean };
export type DismissRequest = { scope?: "group" | "session" };
export type DismissResponse = { ok: true; dismissedUntil: string };

// ---- Phase 5b (features 10, 11) ----

export type PatternRow = {
	id: number;
	repoId: string | null;
	label: string;
	kind: "repo_skill" | "user_skill" | "claude_md_rule" | "claude_md_pointer" | "test_gap";
	sessionIds: string[];
	sessionCount: number;
	tokensTotal: number;
	fingerprint: string | null;
	firstSeen: string;
	lastSeen: string;
	status: "candidate" | "drafted" | "installed" | "dismissed";
	draftPath: string | null;
	inventoryId: number | null;
	estDraftUsd: number | null;
	correctionCount: number | null;
	readFiles: string[] | null;
	testGapPath: string | null;
	error: string | null;
};

/** GET /api/patterns?repo=&status= */
export type PatternsResponse = { patterns: PatternRow[] };
/** POST /api/patterns/:id/draft { mode? }: the draft file, its actual cost and the estimate shown before. */
export type DraftResponse = { draftPath: string; costUsd: number | null; estUsd: number | null };
/** POST /api/patterns/:id/draft-rule: the free deterministic RULE.md. */
export type DraftRuleResponse = { draftPath: string };
/** GET /api/patterns/:id/draft */
/** The draft and the absolute file Install would write (null when it cannot be resolved, e.g. the repo is gone). */
export type DraftFile = { path: string; content: string; target: string | null };
/** POST /api/patterns/:id/install: absolute paths written; 409 with target_exists / repo_missing / invalid_draft / unsafe_target. */
export type InstallResponse = { written: string[]; inventoryId: number | null };

export type ProposedSkill = {
	patternId: number;
	name: string;
	description: string | null;
	repo: { id: string; name: string } | null;
	status: "candidate" | "drafted" | "installed";
	installedDays: number | null;
	invoked: number | null;
	medianTokens: { before: number; after: number | null; pct: number | null } | null;
	medianDurationSec: { before: number; after: number | null } | null;
	action: "draft" | "review" | "widen" | null;
	estUsd: number | null;
	removed: boolean;
	/** Sessions of the pattern ("72k · 4 sessions" on a candidate). */
	sessionCount: number;
	/** Matching sessions since install ("pattern recurred 2× since"); null before install. */
	sessionsSinceInstall: number | null;
};

// ---- Work recap (Phase 6, feature 17) ----

import type { PolishedRecap, Recap } from "../recap/types";

export type {
	BulletSource,
	PolishedRecap,
	Recap,
	RecapActivity,
	RecapBullet,
	RecapDay,
	RecapGroup,
	RecapRange,
} from "../recap/types";

/** GET /api/recap. `text` is what the card shows and "Copy text" copies; repoText is per-repo copy by label. */
export type RecapResponse = {
	recap: Recap;
	text: string;
	markdown: string;
	repoText: Record<string, { text: string; markdown: string }>;
	polishEstUsd: number | null;
};

/** POST /api/recap/polish. */
export type RecapPolishResponse = { polished: PolishedRecap; text: string; markdown: string };

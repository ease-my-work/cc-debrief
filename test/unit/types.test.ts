// Compile-time check of src/server/types.ts: each sample must satisfy its type under `npm run typecheck`.
// The runtime test below only keeps vitest from reporting an empty file.
import { describe, expect, it } from "vitest";
import type {
	ApiError,
	InventoryKind,
	InventoryQuery,
	InventoryResponse,
	ListSessionsQuery,
	Overview,
	OverviewQuery,
	PatternRow,
	ProposedSkill,
	Range,
	RepoDetail,
	RepoRow,
	ReposQuery,
	ReposResponse,
	ReviewBand,
	SessionDetail,
	SessionListItem,
	SessionsResponse,
	StatusResponse,
	ToolStat,
	ToolsResponse,
} from "../../src/server/types";

const range = "7d" satisfies Range;
const kinds = ["skill", "mcp", "plugin", "hook"] satisfies InventoryKind[];

const item = {
	id: "a3f9c21e",
	startedAt: "2026-09-26T11:40:00Z",
	endedAt: "2026-09-26T12:52:00Z",
	surface: "vscode",
	repo: { id: "github.com/me/app", name: "app" },
	type: null,
	typeSource: null,
	summaryLine: "Fix the alembic migration",
	tokens: 388_000,
	costUsd: null,
	partial: true,
	tokensUnknown: false,
	durationSec: 4320,
	models: ["claude-sonnet-4-5"],
	review: null,
	inProgress: false,
	imported: true,
} satisfies SessionListItem;

const overview = {
	tiles: {
		sessions: { total: 1, bySurface: { cli: 0, vscode: 1, desktop: 0, unknown: 0 }, byRepo: [] },
		tokens: { total: 388_000, cacheServedPct: 71 },
		cost: { usd: 0, byModel: [{ model: "claude-sonnet-4-5", label: "Sonnet", usd: 0 }], unknownModelTokens: 0 },
		lines: { added: 2140, removed: 860, files: 118, repos: 4 },
	},
	tokensPerDay: [{ date: "2026-09-26", input: 10, cacheRead: 20, output: 5 }],
	chartNote: null,
	recent: [item],
	budget: null,
} satisfies Overview;

const band = {
	state: "not_reviewed",
	estUsd: 0.18,
	capReached: false,
	findings: [],
	tier2: null,
	dismissedUntil: null,
	permissionPrompts: "not_recorded",
	nudgeDismissed: false,
} satisfies ReviewBand;

const detail = {
	...item,
	cwd: "/home/me/app",
	startReason: "startup",
	permissionMode: "default",
	summary: null,
	outcome: null,
	tags: [],
	summaryState: "pending",
	summaryError: null,
	summaryEstUsd: 0.02,
	summaryCapReached: false,
	resumeCommand: "claude --resume a3f9c21e",
	tokens: {
		input: 1,
		cacheWrite: 2,
		cacheRead: 3,
		output: 4,
		costUsd: null,
		byModel: [{ model: "claude-sonnet-4-5", tokens: 10, costUsd: null }],
		unknown: false,
	},
	turns: [
		{
			seq: 1,
			startedAt: "2026-09-26T11:40:00Z",
			userText: "hi",
			assistantExcerpt: null,
			tools: [{ label: "Bash npm", count: 2, totalMs: 1200, failures: 1, denials: 0 }],
		},
	],
	toolCallCount: 2,
	files: [{ path: "src/a.ts", repo: "app", added: 3, removed: 1, language: "ts" }],
	used: {
		skills: [{ name: "code-review", calls: 1, failures: 0 }],
		mcpServers: [{ name: "github", calls: 2, failures: 1 }],
		tools: [{ name: "Bash", calls: 2, failures: 1 }],
		instructionFiles: [{ path: "CLAUDE.md", kind: "Project", count: 2 }],
	},
	subagents: [{ agentId: "ag1", agentType: "Explore", description: null, turnSeq: 1, toolCalls: 3 }],
	compactions: [{ ts: "2026-09-26T12:00:00Z", trigger: "auto", afterTurnSeq: 1 }],
	review: band,
} satisfies SessionDetail;

const sessions = { items: [item], total: 1, nextCursor: null } satisfies SessionsResponse;

const inventory = {
	strip: {
		installed: 1,
		byScope: { user: 1, plugin: 0, repo: 0 },
		invoked: 0,
		neverInvoked: 1,
		unusedCtxTokensPerSession: 25,
	},
	items: [
		{
			id: 1,
			name: "github",
			source: "user",
			scope: "user",
			path: "/home/me/.claude.json",
			sessionsLoaded: 3,
			sessionsInvoked: 1,
			lastUsed: null,
			ctxTokens: 0,
			status: "never_used",
			removed: false,
			tools: 2,
			calls: 5,
			failures: 0,
			medianMs: 300,
		},
	],
} satisfies InventoryResponse;

const tool = {
	name: "Grep",
	calls: 4,
	failures: 0,
	denials: 0,
	medianMs: 120,
	sessions: 2,
	lastUsed: null,
	category: "search",
} satisfies ToolStat;
const tools = { tools: [tool] } satisfies ToolsResponse;

const repo = {
	id: "github.com/me/app",
	name: "app",
	remoteUrl: null,
	branch: "main",
	branchesSeen: 3,
	sessions: 14,
	tokens: 1,
	costUsd: 0,
	linesAdded: 410,
	linesRemoved: 12,
	repoSkillsUsed: 2,
	repoSkillsAvailable: 4,
	repoMcp: [],
} satisfies RepoRow;
const repos = { repos: [repo] } satisfies ReposResponse;
const pattern = {
	id: 1,
	repoId: null,
	label: "x",
	kind: "repo_skill",
	sessionIds: [],
	sessionCount: 0,
	tokensTotal: 0,
	fingerprint: null,
	firstSeen: "t",
	lastSeen: "t",
	status: "candidate",
	draftPath: null,
	inventoryId: null,
	estDraftUsd: null,
	correctionCount: null,
	readFiles: null,
	testGapPath: null,
	error: null,
} satisfies PatternRow;
const repoDetail = {
	repo,
	files: [{ path: "src/a.ts", sessions: 14, added: 410, removed: 2 }],
	typeMix: [],
	items: [{ kind: "skill", name: "demo", source: "app/.claude/skills", lazy: true, invoked: 0, used: false }],
	suggestions: [],
	languages: [],
	branches: [],
	used: { skills: [], mcpServers: [], agentTypes: [] },
	topTools: [],
	perWeek: [],
} satisfies RepoDetail;

const proposed = {
	patternId: 1,
	name: "x",
	description: null,
	repo: null,
	status: "candidate",
	installedDays: null,
	invoked: null,
	medianTokens: null,
	medianDurationSec: null,
	action: null,
	estUsd: null,
	removed: false,
	sessionCount: 3,
	sessionsSinceInstall: null,
} satisfies ProposedSkill;

const status = {
	ai: { summaries: true, reviews: false, autoReview: false, drafts: false },
	lastIngestAt: null,
	lastHookEventAt: null,
	hooksInstalled: false,
	backfill: { done: 120, total: 283 },
	summaryJob: null,
	reviewJob: null,
	tier1Job: null,
	inProgressSessions: 0,
	pollSeconds: 15,
	pendingSummaries: 0,
	pendingImportedSummaries: 0,
	version: "0.0.0",
} satisfies StatusResponse;

const error = { error: { code: "not_found", message: "No such session" } } satisfies ApiError;

const queries = [
	{ range: "today", repo: "github.com/me/app" } satisfies OverviewQuery,
	{ range, type: "bugfix", q: "alembic", cursor: "abc", limit: 50 } satisfies ListSessionsQuery,
	{ kind: "mcp", range: "30d", unused: true } satisfies InventoryQuery,
	{ range: "30d" } satisfies ReposQuery,
];

describe("shared API types", () => {
	it("have type-checked samples for every Phase 2 response", () => {
		const samples = [kinds, overview, detail, sessions, inventory, tools, repos, repoDetail, pattern, proposed];
		expect([...samples, status, error, queries].every(Boolean)).toBe(true);
	});
});

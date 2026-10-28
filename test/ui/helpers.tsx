// UI test helpers: a mocked fetch routed by pathname, and status / list fixtures typed by the API types.
import type { SessionDetail, SessionListItem, StatusResponse } from "@api-types";
import { vi } from "vitest";

export type SentRequest = { method: string; body: unknown };
export type Handler = (url: URL, req: SentRequest) => { status?: number; body: unknown } | undefined;

/** Every request since the last mockFetch(), with its method and parsed JSON body. */
export const requests: (SentRequest & { url: URL })[] = [];

/** Replaces fetch; handlers are tried in order, unmatched requests get a JSON 404. Returns the request log. */
export function mockFetch(handlers: Handler[]): URL[] {
	const log: URL[] = [];
	requests.length = 0;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(String(input), "http://127.0.0.1:4242");
			log.push(url);
			const req = { method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null };
			requests.push({ url, ...req });
			for (const h of handlers) {
				const hit = h(url, req);
				if (hit)
					return new Response(JSON.stringify(hit.body), {
						status: hit.status ?? 200,
						headers: { "content-type": "application/json" },
					});
			}
			return new Response(JSON.stringify({ error: { code: "not_found", message: "no mock" } }), { status: 404 });
		}),
	);
	return log;
}

export const route =
	(path: string, body: unknown | ((u: URL) => unknown), method = "GET"): Handler =>
	(u, req) =>
		u.pathname === path && req.method === method
			? { body: typeof body === "function" ? (body as (u: URL) => unknown)(u) : body }
			: undefined;

export const statusFixture = (over: Partial<StatusResponse> = {}): StatusResponse => ({
	ai: { summaries: true, reviews: false, autoReview: false, drafts: false },
	lastIngestAt: new Date(Date.now() - 2 * 60_000).toISOString(),
	lastHookEventAt: null,
	hooksInstalled: true,
	backfill: null,
	summaryJob: null,
	reviewJob: null,
	tier1Job: null,
	inProgressSessions: 0,
	pollSeconds: 0,
	pendingSummaries: 0,
	pendingImportedSummaries: 0,
	version: "0.0.0",
	...over,
});

export const sessionItem = (id: string, over: Partial<SessionListItem> = {}): SessionListItem => ({
	id,
	startedAt: new Date(Date.now() - 3_600_000).toISOString(),
	endedAt: new Date(Date.now() - 1_800_000).toISOString(),
	surface: "cli",
	repo: { id: "github.com/me/app", name: "app" },
	type: null,
	typeSource: null,
	summaryLine: `Session ${id}`,
	tokens: 142_000,
	costUsd: 0.61,
	partial: false,
	tokensUnknown: false,
	durationSec: 1800,
	models: ["claude-sonnet-4-5"],
	review: null,
	inProgress: false,
	imported: false,
	...over,
});

/** Puts the test at a client route before rendering. */
export const at = (path: string) => window.history.replaceState(null, "", path);

/** A minimal ended session detail (no turns, files or subagents). */
export const sessionDetail = (id: string, over: Partial<SessionDetail> = {}): SessionDetail => ({
	...sessionItem(id),
	cwd: "/w/app",
	startReason: "startup",
	permissionMode: "default",
	summary: null,
	outcome: null,
	tags: [],
	summaryState: "pending",
	summaryError: null,
	summaryEstUsd: 0.02,
	summaryCapReached: false,
	resumeCommand: `claude --resume ${id}`,
	tokens: { input: 1, cacheWrite: 0, cacheRead: 0, output: 1, costUsd: 0.01, byModel: [], unknown: false },
	turns: [],
	toolCallCount: 0,
	files: [],
	used: { skills: [], mcpServers: [], tools: [], instructionFiles: [] },
	subagents: [],
	compactions: [],
	review: null,
	...over,
});

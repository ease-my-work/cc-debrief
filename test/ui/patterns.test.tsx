import type {
	DigestFooter,
	DigestItem,
	InventoryResponse,
	PatternRow,
	ProposedSkill,
	RepoDetail,
	RepoRow,
} from "@api-types";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../ui/src/app";
import { at, type Handler, mockFetch, requests, route, statusFixture } from "./helpers";

afterEach(() => vi.unstubAllGlobals());

const APP = "github.com/me/app";
const repoRow: RepoRow = {
	id: APP,
	name: "billing-api",
	remoteUrl: null,
	branch: "main",
	branchesSeen: 1,
	sessions: 10,
	tokens: 1,
	costUsd: 1,
	linesAdded: 0,
	linesRemoved: 0,
	repoSkillsUsed: 0,
	repoSkillsAvailable: 0,
	repoMcp: [],
};
const pattern = (id: number, over: Partial<PatternRow> = {}): PatternRow => ({
	id,
	repoId: APP,
	label: "Fix trivy findings in Dockerfile",
	kind: "repo_skill",
	sessionIds: ["a", "b", "c", "d"],
	sessionCount: 4,
	tokensTotal: 290_000,
	fingerprint: "Bash:trivy → Read:Dockerfile → Edit:Dockerfile → Bash:docker build",
	firstSeen: "2026-10-01T00:00:00Z",
	lastSeen: "2026-10-09T00:00:00Z",
	status: "candidate",
	draftPath: null,
	inventoryId: null,
	estDraftUsd: 0.2,
	correctionCount: null,
	readFiles: null,
	testGapPath: null,
	error: null,
	...over,
});

let suggestions: PatternRow[];
function mountRepos(rows: PatternRow[], drafts = true, extra: Handler[] = []) {
	suggestions = rows;
	const detail = (): RepoDetail => ({
		repo: repoRow,
		files: [],
		typeMix: [],
		items: [],
		suggestions,
		languages: [],
		branches: [],
		used: { skills: [], mcpServers: [], agentTypes: [] },
		topTools: [],
		perWeek: [],
	});
	mockFetch([
		...extra,
		route("/api/status", statusFixture({ ai: { summaries: true, reviews: false, autoReview: false, drafts } })),
		route("/api/repos", { repos: [repoRow] }),
		(u) => (u.pathname === `/api/repos/${encodeURIComponent(APP)}` ? { body: detail() } : undefined),
	]);
}
const panel = async () => {
	at(`/repos/${encodeURIComponent(APP)}`);
	render(<App />);
	return within(await screen.findByRole("region", { name: "Repeated work · suggestions" }));
};
const card = (p: ReturnType<typeof within>, label: string) => within(p.getByRole("article", { name: label }));

describe("Repeated work · suggestions", () => {
	it("a candidate card: kind badge, label, facts with the fingerprint, Draft skill (~$) and Dismiss", async () => {
		mountRepos([pattern(1)]);
		const c = card(await panel(), "Fix trivy findings in Dockerfile");
		expect(c.getByText("repo skill")).toBeTruthy();
		expect(c.getByText(/4 sessions in 30 days · ≈ 290k tokens/)).toBeTruthy();
		expect(c.getByText("Bash:trivy → Read:Dockerfile → Edit:Dockerfile → Bash:docker build")).toBeTruthy();
		expect(c.getByRole("button", { name: "Draft skill (~$0.20)" })).toBeTruthy();
		expect(c.getByRole("button", { name: "Dismiss" })).toBeTruthy();
	});

	it("drafts off: the button becomes the Settings link", async () => {
		mountRepos([pattern(1)], false);
		const c = card(await panel(), "Fix trivy findings in Dockerfile");
		expect(c.queryByRole("button", { name: /Draft skill/ })).toBeNull();
		expect(c.getByRole("link", { name: "Enable skill drafts in Settings" }).getAttribute("href")).toBe(
			"/settings#drafts",
		);
	});

	it("Draft skill posts, shows the actual cost and reloads into the drafted card", async () => {
		mountRepos([pattern(1)], true, [
			(u, req) => {
				if (req.method !== "POST" || u.pathname !== "/api/patterns/1/draft") return undefined;
				suggestions = [
					pattern(1, { status: "drafted", draftPath: "/h/.cc-debrief/drafts/billing-api/trivy-fix/SKILL.md" }),
				];
				return { body: { draftPath: "/x", costUsd: 0.18, estUsd: 0.2 } };
			},
		]);
		const p = await panel();
		await userEvent.click(
			card(p, "Fix trivy findings in Dockerfile").getByRole("button", { name: "Draft skill (~$0.20)" }),
		);
		await waitFor(() => expect(p.getByText("drafted")).toBeTruthy());
		expect(p.getByText(/draft ready in drafts\/billing-api\/trivy-fix\//)).toBeTruthy();
		expect(requests.find((r) => r.url.pathname === "/api/patterns/1/draft")?.body).toEqual({ mode: "create" });
	});

	it("a drafted card: Review draft opens the editor; save errors show; Install confirms the exact path", async () => {
		const DRAFTED = pattern(2, { status: "drafted", draftPath: "/h/drafts/billing-api/trivy-fix/SKILL.md" });
		let putStatus = 422;
		mountRepos([DRAFTED], true, [
			(u, req) => {
				if (u.pathname !== "/api/patterns/2/draft") return undefined;
				if (req.method === "GET")
					return {
						body: {
							path: DRAFTED.draftPath,
							content: "---\nname: trivy-fix\ndescription: Fix.\n---\nBody\n",
							target: "/repo/.claude/skills/trivy-fix/SKILL.md",
						},
					};
				return putStatus === 422
					? {
							status: 422,
							body: { error: { code: "invalid_draft", message: "front matter `name` must be kebab-case" } },
						}
					: { body: { ok: true } };
			},
			(u, req) =>
				req.method === "POST" && u.pathname === "/api/patterns/2/install"
					? { body: { written: ["/repo/.claude/skills/trivy-fix/SKILL.md"], inventoryId: 7 } }
					: undefined,
		]);
		const c = card(await panel(), "Fix trivy findings in Dockerfile");
		await userEvent.click(c.getByRole("button", { name: "Review draft" }));
		const box = (await c.findByRole("textbox", { name: "Draft content" })) as HTMLTextAreaElement;
		await waitFor(() => expect(box.value).toContain("name: trivy-fix"));
		await userEvent.click(c.getByRole("button", { name: "Save" }));
		await waitFor(() => expect(c.getByText("front matter `name` must be kebab-case")).toBeTruthy());
		putStatus = 200;
		await userEvent.click(c.getByRole("button", { name: "Save" }));
		await waitFor(() => expect(c.getByText("Saved")).toBeTruthy());
		await userEvent.click(c.getByRole("button", { name: "Install to repo" }));
		const confirm = within(await c.findByLabelText("Install confirm"));
		expect(confirm.getByText("/repo/.claude/skills/trivy-fix/SKILL.md")).toBeTruthy();
		await userEvent.click(confirm.getByRole("button", { name: "Install" }));
		await waitFor(() => expect(c.getByText("/repo/.claude/skills/trivy-fix/SKILL.md")).toBeTruthy());
		expect(c.getByText(/Written:/)).toBeTruthy();
	});

	it("an installed card: green installed badge and no buttons", async () => {
		mountRepos([
			pattern(4, { status: "installed", draftPath: "/h/drafts/billing-api/trivy-fix/SKILL.md", inventoryId: 7 }),
		]);
		const c = card(await panel(), "Fix trivy findings in Dockerfile");
		expect(c.getByText("installed").className).toContain("text-good");
		expect(c.queryAllByRole("button")).toEqual([]);
		expect(c.queryByRole("link", { name: "Enable skill drafts in Settings" })).toBeNull();
	});

	it("a rule card: Add to CLAUDE.md drafts the free rule and previews the exact text and file before appending", async () => {
		const RULE = pattern(3, {
			kind: "claude_md_rule",
			label: "use httpx not requests",
			correctionCount: 3,
			tokensTotal: 40_000,
			fingerprint: null,
		});
		mountRepos([RULE], false, [
			(u, req) =>
				req.method === "POST" && u.pathname === "/api/patterns/3/draft-rule"
					? { body: { draftPath: "/d/RULE.md" } }
					: undefined,
			(u, req) =>
				req.method === "GET" && u.pathname === "/api/patterns/3/draft"
					? { body: { path: "/d/RULE.md", content: "Use httpx, not requests.\n", target: "/repo/CLAUDE.md" } }
					: undefined,
			(u, req) =>
				req.method === "POST" && u.pathname === "/api/patterns/3/install"
					? { body: { written: ["/repo/CLAUDE.md"], inventoryId: null } }
					: undefined,
		]);
		const c = card(await panel(), "use httpx not requests");
		expect(c.getByText("CLAUDE.md rule")).toBeTruthy();
		expect(c.getByText(/Corrected by you in 3 sessions · ≈ 40k tokens/)).toBeTruthy();
		expect(c.queryByRole("button", { name: /Rewrite with Claude/ })).toBeNull(); // drafts off
		await userEvent.click(c.getByRole("button", { name: "Add to CLAUDE.md" }));
		const preview = within(await c.findByLabelText("CLAUDE.md preview"));
		expect(preview.getByText("Use httpx, not requests.")).toBeTruthy();
		expect(preview.getByText("/repo/CLAUDE.md")).toBeTruthy();
		await userEvent.click(preview.getByRole("button", { name: "Append" }));
		await waitFor(() => expect(c.getByText("/repo/CLAUDE.md")).toBeTruthy());
		expect(requests.map((r) => r.url.pathname)).toEqual(
			expect.arrayContaining(["/api/patterns/3/draft-rule", "/api/patterns/3/install"]),
		);
	});

	it("a test gap is one line with a red badge", async () => {
		mountRepos([
			pattern(4, { kind: "test_gap", label: "services/gks/cache.py", testGapPath: "services/gks/cache.py" }),
		]);
		const p = await panel();
		expect(p.getByText("test gap").className).toContain("text-bad");
		expect(p.getByText(/fixed in 4 separate bugfix sessions/)).toBeTruthy();
		expect(p.queryByRole("article")).toBeNull();
	});

	it("Dismiss posts and reloads", async () => {
		mountRepos([pattern(1)], true, [
			(u, req) => {
				if (req.method !== "POST" || u.pathname !== "/api/patterns/1/dismiss") return undefined;
				suggestions = [];
				return { body: { ok: true } };
			},
		]);
		const p = await panel();
		await userEvent.click(card(p, "Fix trivy findings in Dockerfile").getByRole("button", { name: "Dismiss" }));
		await waitFor(() => expect(p.getByText("No repeated work found in the last 30 days.")).toBeTruthy());
	});
});

describe("Skills proposed from repeated work", () => {
	const proposed = (over: Partial<ProposedSkill>): ProposedSkill => ({
		patternId: 1,
		name: "alembic-column",
		description: "Add Alembic migration for a new column",
		repo: { id: APP, name: "billing-api" },
		status: "installed",
		installedDays: 12,
		invoked: 6,
		medianTokens: { before: 82_000, after: 51_000, pct: -38 },
		medianDurationSec: { before: 34 * 60, after: 19 * 60 },
		action: null,
		estUsd: null,
		removed: false,
		sessionCount: 9,
		sessionsSinceInstall: 4,
		...over,
	});
	const skills = (rows: ProposedSkill[]): InventoryResponse => ({
		strip: {
			installed: 1,
			byScope: { user: 1, plugin: 0, repo: 0 },
			invoked: 0,
			neverInvoked: 0,
			unusedCtxTokensPerSession: 0,
		},
		items: [],
		proposed: rows,
	});

	it("badges, invoked, before → after medians and actions", async () => {
		mockFetch([
			route("/api/status", statusFixture()),
			route("/api/repos", { repos: [] }),
			route(
				"/api/inventory",
				skills([
					proposed({}),
					proposed({
						patternId: 2,
						name: "trivy-fix",
						status: "candidate",
						installedDays: null,
						invoked: null,
						medianTokens: { before: 72_000, after: null, pct: null },
						medianDurationSec: { before: 28 * 60, after: null },
						action: "draft",
						estUsd: 0.2,
						sessionCount: 4,
						sessionsSinceInstall: null,
					}),
					proposed({
						patternId: 3,
						name: "teams-webhook-debug",
						installedDays: 16,
						invoked: 0,
						medianTokens: { before: 60_000, after: null, pct: null },
						medianDurationSec: null,
						action: "widen",
						estUsd: 0.05,
						sessionsSinceInstall: 2,
					}),
				]),
			),
		]);
		at("/skills");
		render(<App />);
		const t = within(await screen.findByRole("region", { name: "Skills proposed from repeated work" }));
		const rowOf = (name: string) => within(t.getByText(name).closest("tr") as HTMLElement);
		const a = rowOf("alembic-column");
		expect(a.getByText("installed 12d").className).toContain("text-good");
		expect(a.getByText("82k → 51k")).toBeTruthy();
		expect(a.getByText("−38%")).toBeTruthy();
		expect(a.getByText("34m → 19m")).toBeTruthy();
		const c = rowOf("trivy-fix");
		expect(c.getByText("candidate")).toBeTruthy();
		expect(c.getByText("72k")).toBeTruthy();
		expect(c.getByText("4 sessions")).toBeTruthy();
		expect(c.getByRole("button", { name: "Draft (~$0.20)" })).toBeTruthy();
		const w = rowOf("teams-webhook-debug");
		expect(w.getByText("installed 16d · 0 invoked").className).toContain("text-amber");
		expect(w.getByText("pattern recurred 2× since")).toBeTruthy();
		expect(w.getByRole("button", { name: "Widen description (~$0.05)" })).toBeTruthy();
		expect(t.getByText("benefit = sessions matching the pattern, before vs after install")).toBeTruthy();
	});
});

describe("Skills & Tools with nothing installed", () => {
	it("still shows the proposed skills instead of the empty state", async () => {
		mockFetch([
			route("/api/status", statusFixture()),
			route("/api/repos", { repos: [] }),
			route("/api/inventory", {
				strip: {
					installed: 0,
					byScope: { user: 0, plugin: 0, repo: 0 },
					invoked: 0,
					neverInvoked: 0,
					unusedCtxTokensPerSession: 0,
				},
				items: [],
				proposed: [
					{
						patternId: 1,
						name: "Fix trivy findings",
						description: null,
						repo: { id: APP, name: "billing-api" },
						status: "candidate",
						installedDays: null,
						invoked: null,
						medianTokens: { before: 72_000, after: null, pct: null },
						medianDurationSec: null,
						action: "draft",
						estUsd: 0.2,
						removed: false,
						sessionCount: 4,
						sessionsSinceInstall: null,
					},
				],
			} satisfies InventoryResponse),
		]);
		at("/skills");
		render(<App />);
		expect(await screen.findByRole("region", { name: "Skills proposed from repeated work" })).toBeTruthy();
		expect(screen.queryByText("Nothing installed found")).toBeNull();
	});
});

describe("digest pattern items", () => {
	it("use the accent dot and an inline Draft skill (~$) that shows the actual cost", async () => {
		const item: DigestItem = {
			id: 9,
			rule: "repeat_pattern",
			severity: "low",
			message: "Repeated work in `billing-api`: fix trivy findings — 4 sessions in 30 days",
			costTokens: 290_000,
			sessionCount: 0,
			repoId: APP,
			target: "repos",
			href: `/repos/${encodeURIComponent(APP)}`,
			demoted: false,
			collapsed: false,
			feedback: null,
			action: { kind: "draft", patternId: 5, estUsd: 0.2 },
		};
		const footer: DigestFooter = {
			reviewsThisWeek: 0,
			reviewCostUsd: 0,
			dismissed: 0,
			eligibleUnreviewed: 0,
			estReviewAllUsd: 0,
			reviewsEnabled: false,
			nudgeDismissed: true,
			selfUsage: { summaries: 0, reviews: 0, drafts: 0, recaps: 0, tokens: 0, usd: 0, sharePct: null },
		};
		mockFetch([
			route("/api/status", statusFixture()),
			route("/api/repos", { repos: [] }),
			route("/api/overview", {
				tiles: {
					sessions: { total: 1, bySurface: { cli: 1, vscode: 0, desktop: 0, unknown: 0 }, byRepo: [] },
					tokens: { total: 10, cacheServedPct: 0 },
					cost: { usd: 1, byModel: [], unknownModelTokens: 0 },
					lines: { added: 0, removed: 0, files: 0, repos: 0 },
				},
				tokensPerDay: [],
				chartNote: null,
				recent: [],
			}),
			route("/api/improvements", { items: [item], footer }),
			(u, req) =>
				req.method === "POST" && u.pathname === "/api/patterns/5/draft"
					? { body: { draftPath: "/d", costUsd: 0.17, estUsd: 0.2 } }
					: undefined,
		]);
		at("/");
		render(<App />);
		const digest = within(await screen.findByRole("region", { name: "This week's coaching digest" }));
		const row = (await digest.findByText(/Repeated work in/)).closest("li") as HTMLElement;
		expect((row.querySelector("[data-dot]") as HTMLElement).style.background).toBe("rgb(52, 83, 196)");
		await userEvent.click(within(row).getByRole("button", { name: "Draft skill (~$0.20)" }));
		await waitFor(() => expect(within(row).getByText("drafted · cost $0.17")).toBeTruthy());
	});
});

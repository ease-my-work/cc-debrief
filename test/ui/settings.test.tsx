import type { Config, ConfigResponse, RepoRow, SelfUsage } from "@api-types";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../ui/src/app";
import { at, mockFetch, requests, statusFixture } from "./helpers";

const DEFAULTS: Config = {
	ai: {
		summaries: { enabled: true },
		maxPerDay: 50,
		review: { enabled: false, auto: false, autoThreshold: { turns: 20, tokens: 200_000 }, maxPerDay: 10 },
		drafts: { enabled: false },
	},
	capture: { redact: ["@default"], maxFieldBytes: 32_768, permissionHook: true },
	retention: { days: 90 },
	recap: { hiddenRepos: [] },
	budget: { monthlyUsd: null },
	pricing: { overrides: {} },
	dashboard: { port: 4242, pollSeconds: 15 },
};

const usage = (range: "7d" | "30d"): SelfUsage => {
	const calls = range === "7d" ? 42 : 50;
	return {
		range,
		byFeature: [
			{ feature: "summary", calls, failed: 0, tokens: 246_000, cacheReadTokens: 150_000, usd: 1, sharePct: 5.05 },
			{ feature: "review", calls: 6, failed: 0, tokens: 64_000, cacheReadTokens: 30_000, usd: 0.4, sharePct: 2.02 },
			{ feature: "draft", calls: 0, failed: 0, tokens: 0, cacheReadTokens: 0, usd: 0, sharePct: 0 },
			{ feature: "recap", calls: 0, failed: 0, tokens: 0, cacheReadTokens: 0, usd: 0, sharePct: 0 },
		],
		total: { calls: calls + 6, failed: 0, tokens: 310_000, usd: 1.4, sharePct: 7.07 },
		userUsd: 18.4,
	};
};

let config: Config;
let knownRepos: RepoRow[] = [];
let errors: ConfigResponse["errors"];
let repricing: ConfigResponse["pricing"]["repricing"] = null;
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

function setPath(root: Record<string, unknown>, key: string, value: unknown) {
	const parts = key.split(".");
	let cur = root;
	for (const p of parts.slice(0, -1)) cur = cur[p] as Record<string, unknown>;
	if (value === undefined) delete cur[parts.at(-1) as string];
	else cur[parts.at(-1) as string] = value;
}

beforeEach(() => {
	config = clone(DEFAULTS);
	knownRepos = [];
	errors = [];
	repricing = null;
	mockFetch([
		(u, req) => {
			if (u.pathname === "/api/config" && req.method === "GET") {
				return {
					body: {
						config,
						defaults: DEFAULTS,
						explicit: [],
						path: "/home/u/.cc-debrief/config.json",
						errors,
						defaultRedactCount: 13,
						demotedRules: [],
						usedToday: { summaries: 12, reviews: 0 },
						pendingSummaries: 3,
						estimates: { summaryUsd: 0.02, reviewUsd: 0.08, draftUsd: 0.2 },
						dataDir: "/home/u/.cc-debrief",
						dbBytes: 212 * 1024 * 1024,
						storage: { projectsBytes: 1.5 * 1024 * 1024 * 1024, projectsCut: false },
						pricing: {
							tableVersion: "2026-09-30",
							effectiveVersion: "2026-09-30",
							builtIn: [
								{ model: "claude-opus-5-5", input: 4, output: 20, cacheWrite: 5, cacheWrite1h: 8, cacheRead: 0.2 },
								{ model: "claude-sonnet-4-5", input: 3, output: 15, cacheWrite: 3.75, cacheWrite1h: 6, cacheRead: 0.3 },
							],
							repricing,
						},
					} satisfies ConfigResponse,
				};
			}
			if (u.pathname === "/api/config" && req.method === "PUT") {
				const patch = req.body as { set?: Record<string, unknown>; unset?: string[] };
				const bad = Object.entries(patch.set ?? {}).find(
					([k, v]) => k.endsWith("maxPerDay") && (typeof v !== "number" || v > 1000),
				);
				if (bad) {
					return {
						status: 422,
						body: {
							error: {
								code: "invalid_config",
								message: `${bad[0]} must be an integer between 0 and 1000`,
								fields: [{ key: bad[0], message: "must be an integer between 0 and 1000" }],
							},
						},
					};
				}
				const next = clone(config) as unknown as Record<string, unknown>;
				for (const [k, v] of Object.entries(patch.set ?? {})) setPath(next, k, v);
				for (const k of patch.unset ?? []) setPath(next, k, undefined);
				config = next as unknown as Config;
				return { body: { config, changed: [...Object.keys(patch.set ?? {}), ...(patch.unset ?? [])] } };
			}
			return undefined;
		},
		(u) =>
			u.pathname === "/api/status"
				? {
						body: statusFixture({
							ai: {
								summaries: config.ai.summaries.enabled,
								reviews: config.ai.review.enabled,
								autoReview: config.ai.review.auto,
								drafts: config.ai.drafts.enabled,
							},
						}),
					}
				: undefined,
		(u) =>
			u.pathname === "/api/self-usage"
				? { body: usage((u.searchParams.get("range") as "7d" | "30d") ?? "7d") }
				: undefined,
		(u) =>
			u.pathname === "/api/config/retention-preview"
				? { body: { sessions: Number(u.searchParams.get("days")) < 90 ? 38 : 0 } }
				: undefined,
		(u, req) => (u.pathname === "/api/nudges/reset" && req.method === "POST" ? { body: { ok: true } } : undefined),
		(u) => (u.pathname === "/api/repos" ? { body: { repos: knownRepos } } : undefined),
	]);
});
afterEach(() => vi.unstubAllGlobals());

const puts = () => requests.filter((r) => r.method === "PUT" && r.url.pathname === "/api/config");
const open = async () => {
	at("/settings");
	render(<App />);
	await screen.findByRole("heading", { name: "Settings" });
	await screen.findByRole("switch", { name: "Session summaries" });
};

const repoRow = (name: string): RepoRow => ({
	id: `github.com/acme/${name}`,
	name,
	remoteUrl: null,
	branch: null,
	branchesSeen: 1,
	sessions: 1,
	tokens: 0,
	costUsd: 0,
	linesAdded: 0,
	linesRemoved: 0,
	repoSkillsUsed: 0,
	repoSkillsAvailable: 0,
	repoMcp: [],
});

describe("Settings: Recap section", () => {
	it("lists known repos and hidden names, saves recap.hiddenRepos, and shows the honest note", async () => {
		knownRepos = [repoRow("api-gateway"), repoRow("secret-client")];
		config.recap.hiddenRepos = ["old-client"];
		await open();
		const section = within(await screen.findByRole("region", { name: "Recap" }));
		const box = (name: string) => section.getByRole("checkbox", { name }) as HTMLInputElement;
		expect(await section.findByRole("checkbox", { name: "secret-client" })).toBeTruthy();
		expect(box("old-client").checked).toBe(true);
		expect(box("api-gateway").checked).toBe(false);
		await userEvent.click(box("secret-client"));
		await waitFor(() =>
			expect(puts().at(-1)?.body).toEqual({ set: { "recap.hiddenRepos": ["old-client", "secret-client"] } }),
		);
		await waitFor(() => expect(box("secret-client").checked).toBe(true));
		await userEvent.click(box("old-client"));
		await waitFor(() => expect(puts().at(-1)?.body).toEqual({ set: { "recap.hiddenRepos": ["secret-client"] } }));
		expect(
			section.getByText(
				"Hiding a repo removes its sessions and files from the recap. It cannot remove words about that work from a session title or summary in another repo.",
			),
		).toBeTruthy();
		expect(document.getElementById("recap")).toBeTruthy();
	});
});

describe("Settings view", () => {
	it("toggling summaries saves once and updates the sidebar", async () => {
		await open();
		expect(await screen.findByText("AI: summaries on · reviews off")).toBeTruthy();
		await userEvent.click(screen.getByRole("switch", { name: "Session summaries" }));
		await waitFor(() => expect(puts()).toHaveLength(1));
		expect(puts()[0].body).toEqual({ set: { "ai.summaries.enabled": false } });
		expect(await screen.findByText("AI: summaries off · reviews off")).toBeTruthy();
		expect(screen.getByRole("switch", { name: "Session summaries" }).getAttribute("aria-checked")).toBe("false");
	});

	it("shows the cost line and today's counters next to the summary cap", async () => {
		await open();
		expect(screen.getByText(/one claude -p call per finished session · ~\$0\.02 each/)).toBeTruthy();
		expect(screen.getByText("12 used today · 3 pending")).toBeTruthy();
	});

	it("an invalid per-day value shows the server message under the field and keeps the old value", async () => {
		await open();
		const input = screen.getByRole("spinbutton", { name: "Summaries per day" }) as HTMLInputElement;
		await userEvent.clear(input);
		await userEvent.type(input, "5000");
		await userEvent.tab();
		expect(await screen.findByText("must be an integer between 0 and 1000")).toBeTruthy();
		expect(input.value).toBe("50");
		expect(config.ai.maxPerDay).toBe(50);
	});

	it("disables the review cap and auto-review while reviews are off", async () => {
		await open();
		expect((screen.getByRole("spinbutton", { name: "Reviews per day" }) as HTMLInputElement).disabled).toBe(true);
		expect((screen.getByRole("switch", { name: "Auto-review long sessions" }) as HTMLButtonElement).disabled).toBe(
			true,
		);
	});

	it("shows the cost note before enabling reviews, and saves only on confirm", async () => {
		await open();
		await userEvent.click(screen.getByRole("switch", { name: "Tier 2 reviews" }));
		expect(await screen.findByText(/About \$0\.08 per review/)).toBeTruthy();
		expect(puts()).toHaveLength(0);
		await userEvent.click(screen.getByRole("button", { name: "Turn on reviews" }));
		await waitFor(() => expect(puts()[0]?.body).toEqual({ set: { "ai.review.enabled": true } }));
		await waitFor(() =>
			expect((screen.getByRole("spinbutton", { name: "Reviews per day" }) as HTMLInputElement).disabled).toBe(false),
		);
	});

	it("lowering retention previews the deletion and saves on confirm; cancel restores", async () => {
		await open();
		const days = screen.getByRole("spinbutton", { name: "Keep data for (days)" }) as HTMLInputElement;
		await userEvent.clear(days);
		await userEvent.type(days, "30");
		await userEvent.tab();
		expect(await screen.findByText(/Next retention run deletes 38 sessions/)).toBeTruthy();
		expect(puts()).toHaveLength(0);
		await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(days.value).toBe("90");
		await userEvent.clear(days);
		await userEvent.type(days, "30");
		await userEvent.tab();
		await userEvent.click(await screen.findByRole("button", { name: "Save 30 days" }));
		await waitFor(() => expect(puts()[0]?.body).toEqual({ set: { "retention.days": 30 } }));
	});

	it("the Test box redacts a built-in and a custom pattern", async () => {
		config.capture.redact = ["@default", "/ACME-\\d+/g"];
		await open();
		await userEvent.type(
			screen.getByRole("textbox", { name: "Sample text" }),
			"key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA and ACME-1234",
		);
		expect(await screen.findByText("key [REDACTED] and [REDACTED]")).toBeTruthy();
	});

	it("adds and removes patterns, and can remove the built-in set", async () => {
		await open();
		await userEvent.type(screen.getByRole("textbox", { name: "Add a pattern" }), "/ACME-\\d+/g");
		await userEvent.click(screen.getByRole("button", { name: "Add" }));
		await waitFor(() => expect(puts()[0]?.body).toEqual({ set: { "capture.redact": ["@default", "/ACME-\\d+/g"] } }));
		await userEvent.click(await screen.findByRole("button", { name: "Remove built-in secret patterns" }));
		await waitFor(() => expect(puts()[1]?.body).toEqual({ set: { "capture.redact": ["/ACME-\\d+/g"] } }));
	});

	it("refuses a pattern that does not compile, without saving", async () => {
		await open();
		await userEvent.type(screen.getByRole("textbox", { name: "Add a pattern" }), "/(/g");
		await userEvent.click(screen.getByRole("button", { name: "Add" }));
		expect(await screen.findByText("Not a valid regular expression")).toBeTruthy();
		expect(puts()).toHaveLength(0);
	});

	it("shows a banner naming the file and the invalid keys", async () => {
		errors = [{ key: "retention.days", message: "must be an integer between 0 and 3650" }];
		await open();
		const banner = screen.getByRole("alert");
		expect(within(banner).getByText(/config\.json has 1 invalid key/)).toBeTruthy();
		expect(within(banner).getByText(/retention\.days/)).toBeTruthy();
		expect(within(banner).getByText(/\/home\/u\/\.cc-debrief\/config\.json/)).toBeTruthy();
	});

	it("the usage table switches between 7 and 30 days", async () => {
		await open();
		const table = await screen.findByRole("table", { name: "Tracker usage" });
		await within(table).findByText("42");
		await userEvent.click(screen.getByRole("button", { name: "30 days" }));
		expect(await within(table).findByText("50")).toBeTruthy();
		expect(
			requests.some((r) => r.url.pathname === "/api/self-usage" && r.url.searchParams.get("range") === "30d"),
		).toBe(true);
		expect(within(table).getByText("7.1%")).toBeTruthy();
	});

	it("Show tips again resets the nudges", async () => {
		await open();
		await userEvent.click(screen.getByRole("button", { name: "Show tips again" }));
		await waitFor(() =>
			expect(requests.some((r) => r.method === "POST" && r.url.pathname === "/api/nudges/reset")).toBe(true),
		);
	});

	it("unsets the model pin when the field is cleared", async () => {
		config.ai.model = "haiku";
		await open();
		const model = screen.getByRole("textbox", { name: "Model for tracker calls" }) as HTMLInputElement;
		await waitFor(() => expect(model.value).toBe("haiku"));
		await userEvent.clear(model);
		await userEvent.tab();
		await waitFor(() => expect(puts()[0]?.body).toEqual({ unset: ["ai.model"] }));
	});

	it("notes that port and refresh apply on next start, and shows the data location", async () => {
		await open();
		expect(screen.getByText(/apply on next start/)).toBeTruthy();
		expect(screen.getByText(/212 MB/)).toBeTruthy();
		expect(screen.getByText("cc-debrief purge")).toBeTruthy();
		expect(screen.getByText("cc-debrief uninit")).toBeTruthy();
	});
});

describe("Pricing (Phase 7 P7)", () => {
	it("shows the table date and built-in rows, adds an override and removes it", async () => {
		await open();
		const section = within(screen.getByRole("region", { name: "Pricing" }));
		expect(section.getByText(/Built-in prices as of 2026-09-30/)).toBeTruthy();
		expect(section.getByText("claude-sonnet-4-5")).toBeTruthy();
		expect(section.getByText(/keep Claude Code's own cost/)).toBeTruthy();

		await userEvent.type(section.getByRole("textbox", { name: "Model or family" }), "opus");
		await userEvent.type(section.getByRole("textbox", { name: "Input $/M" }), "4");
		await userEvent.type(section.getByRole("textbox", { name: "Output $/M" }), "20");
		await userEvent.click(section.getByRole("button", { name: "Add override" }));
		await waitFor(() =>
			expect(puts().at(-1)?.body).toEqual({ set: { "pricing.overrides.opus": { input: 4, output: 20 } } }),
		);

		await userEvent.click(await section.findByRole("button", { name: "Remove override opus" }));
		await waitFor(() => expect(puts().at(-1)?.body).toEqual({ unset: ["pricing.overrides.opus"] }));
	});

	it("says how many sessions are being re-priced", async () => {
		repricing = { done: 3, total: 10 };
		await open();
		expect(
			within(screen.getByRole("region", { name: "Pricing" })).getByText("Re-pricing 10 sessions (3 done)"),
		).toBeTruthy();
	});

	it("rejects a non-number price without saving", async () => {
		await open();
		const section = within(screen.getByRole("region", { name: "Pricing" }));
		await userEvent.type(section.getByRole("textbox", { name: "Model or family" }), "opus");
		await userEvent.type(section.getByRole("textbox", { name: "Input $/M" }), "cheap");
		await userEvent.type(section.getByRole("textbox", { name: "Output $/M" }), "20");
		await userEvent.click(section.getByRole("button", { name: "Add override" }));
		expect(section.getByText("Prices must be numbers of dollars per million tokens.")).toBeTruthy();
		expect(puts()).toHaveLength(0);
	});
});

describe("Budget (Phase 7 P4)", () => {
	it("saves a monthly budget and clears it", async () => {
		await open();
		const field = screen.getByRole("textbox", { name: "Monthly budget (USD)" });
		await userEvent.type(field, "250");
		await userEvent.tab();
		await waitFor(() => expect(puts().at(-1)?.body).toEqual({ set: { "budget.monthlyUsd": 250 } }));
		await userEvent.clear(field);
		await userEvent.tab();
		await waitFor(() => expect(puts().at(-1)?.body).toEqual({ unset: ["budget.monthlyUsd"] }));
	});
});

describe("Storage (Phase 7 P11)", () => {
	it("shows Claude Code's transcript folder size next to the tracker's data", async () => {
		await open();
		expect(screen.getByText("Claude Code transcripts (~/.claude/projects) · 1.5 GB")).toBeTruthy();
	});
});

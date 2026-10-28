import type { Config, ConfigResponse } from "@api-types";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../ui/src/app";
import { at, mockFetch, requests, route, statusFixture } from "./helpers";

const CONFIG: Config = {
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

let demoted: ConfigResponse["demotedRules"];
beforeEach(() => {
	demoted = [
		{ rule: "retry_loop", notHelpful: 3, demotedAt: "2026-10-01T10:00:00.000Z" },
		{ rule: "unused_mcp", notHelpful: 4, demotedAt: "2026-10-02T10:00:00.000Z" },
	];
	mockFetch([
		route("/api/status", statusFixture()),
		route("/api/repos", { repos: [] }),
		route("/api/self-usage", (u: URL) => ({
			range: u.searchParams.get("range") ?? "7d",
			byFeature: [],
			total: { calls: 0, failed: 0, tokens: 0, usd: 0, sharePct: null },
			userUsd: 0,
		})),
		route("/api/config", () => ({
			config: CONFIG,
			defaults: CONFIG,
			explicit: [],
			path: "/home/u/.cc-debrief/config.json",
			errors: [],
			defaultRedactCount: 13,
			demotedRules: demoted,
			usedToday: { summaries: 0, reviews: 0 },
			pendingSummaries: 0,
			estimates: { summaryUsd: null, reviewUsd: null, draftUsd: null },
			dataDir: "/home/u/.cc-debrief",
			dbBytes: 0,
			storage: { projectsBytes: 0, projectsCut: false },
			pricing: { tableVersion: "2026-09-30", effectiveVersion: "2026-09-30", builtIn: [], repricing: null },
		})),
		(u, req) => {
			const m = /^\/api\/findings\/rules\/([^/]+)\/enable$/.exec(u.pathname);
			if (!m || req.method !== "POST") return undefined;
			demoted = demoted.filter((d) => d.rule !== m[1]);
			return { body: { ok: true } };
		},
	]);
});
afterEach(() => vi.unstubAllGlobals());

describe("Demoted coaching rules in Settings", () => {
	it("lists demoted rules by label with their not-helpful count and re-enables one", async () => {
		at("/settings");
		render(<App />);
		const list = within(await screen.findByRole("list", { name: "Demoted coaching rules" }));
		const items = list.getAllByRole("listitem");
		expect(items.map((li) => li.textContent)).toEqual([
			expect.stringContaining("retry loop · 3 not helpful"),
			expect.stringContaining("unused MCP · 4 not helpful"),
		]);
		await userEvent.click(within(items[0]).getByRole("button", { name: "Re-enable" }));
		await waitFor(() => expect(screen.queryByText(/retry loop · 3 not helpful/)).toBeNull());
		expect(
			requests.some((r) => r.method === "POST" && r.url.pathname === "/api/findings/rules/retry_loop/enable"),
		).toBe(true);
	});

	it("explains the list when nothing is demoted", async () => {
		demoted = [];
		at("/settings");
		render(<App />);
		expect(
			await screen.findByText("None. A rule you mark “not helpful” three times moves here, and you can re-enable it."),
		).toBeTruthy();
	});
});

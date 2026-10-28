import type { ReviewBand, SessionDetail } from "@api-types";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../ui/src/app";
import { at, mockFetch, requests, route, sessionDetail, sessionItem, statusFixture } from "./helpers";

const band = (over: Partial<ReviewBand> = {}): ReviewBand => ({
	state: "disabled",
	estUsd: null,
	capReached: false,
	findings: [
		{
			id: 11,
			rule: "retry_loop",
			label: "retry loop",
			severity: "high",
			message: "npm test failed 3 times before passing — 28% of session tokens",
			turns: [2, 4],
			costTokens: 900,
			collapsed: false,
			feedback: null,
		},
		{
			id: 12,
			rule: "context_churn",
			label: "context churn",
			severity: "low",
			message: "`src/app.ts` was read again unchanged (turn 3)",
			turns: [3],
			costTokens: 100,
			collapsed: false,
			feedback: "helpful",
		},
	],
	tier2: null,
	dismissedUntil: null,
	permissionPrompts: "recorded",
	nudgeDismissed: false,
	...over,
});

let detail: SessionDetail;
beforeEach(() => {
	detail = sessionDetail("s-1", { review: band() });
	mockFetch([
		route("/api/status", statusFixture()),
		route("/api/repos", { repos: [] }),
		route("/api/sessions", { items: [sessionItem("s-1")], total: 1, nextCursor: null }),
		route("/api/sessions/s-1", () => detail),
		(u, req) => {
			if (req.method !== "POST") return undefined;
			if (u.pathname === "/api/findings/11/dismiss") {
				detail = { ...detail, review: band({ findings: [], dismissedUntil: "2026-11-01T00:00:00.000Z" }) };
				return { body: { ok: true, dismissedUntil: "2026-11-01T00:00:00.000Z" } };
			}
			if (/^\/api\/findings\/\d+\/feedback$/.test(u.pathname)) return { body: { ok: true, demoted: false } };
			if (u.pathname === "/api/nudges/session/dismiss") {
				detail = { ...detail, review: band({ nudgeDismissed: true }) };
				return { body: { ok: true } };
			}
			return undefined;
		},
	]);
});
afterEach(() => vi.unstubAllGlobals());

const open = async () => {
	at("/sessions/s-1");
	render(<App />);
	return within(await screen.findByRole("region", { name: "Session review" }));
};

describe("Session review band", () => {
	it("shows badges coloured by severity with messages and turn numbers", async () => {
		const b = await open();
		const high = b.getByText("retry loop");
		expect(high.style.background).toBe("rgb(252, 235, 231)");
		expect(high.style.color).toBe("rgb(155, 58, 36)");
		expect(b.getByText("context churn").style.background).toBe("rgb(231, 238, 255)");
		expect(b.getByText(/npm test failed 3 times before passing — 28% of session tokens/)).toBeTruthy();
		expect(b.getByText(/· turns 2, 4/)).toBeTruthy();
		// the churn finding already names its turn in the message, so no second turn note
		expect(b.queryByText(/· turn 3/)).toBeNull();
		expect(b.getByText("src/app.ts").className).toContain("mono");
	});

	it("sends per-finding feedback and shows the voted state", async () => {
		const b = await open();
		const [, second] = b.getAllByRole("button", { name: "Helpful" });
		expect(second.getAttribute("aria-pressed")).toBe("true");
		const [down] = b.getAllByRole("button", { name: "Not helpful" });
		await userEvent.click(down);
		await waitFor(() => expect(down.getAttribute("aria-pressed")).toBe("true"));
		expect(requests.find((r) => r.url.pathname === "/api/findings/11/feedback")?.body).toEqual({
			value: "not_helpful",
		});
	});

	it("Dismiss 30d hides the session's findings", async () => {
		const b = await open();
		await userEvent.click(b.getByRole("button", { name: "Dismiss 30d" }));
		await waitFor(() => expect(screen.queryByText("retry loop")).toBeNull());
		expect(requests.find((r) => r.url.pathname === "/api/findings/11/dismiss")?.body).toEqual({ scope: "session" });
	});

	it("shows permission prompts not recorded for an imported session", async () => {
		detail = sessionDetail("s-1", { imported: true, review: band({ permissionPrompts: "not_recorded" }) });
		const b = await open();
		expect(b.getByText("Permission prompts: not recorded (imported session)")).toBeTruthy();
	});

	it("leaves the line out when prompts were recorded, and never shows a discarded-work line", async () => {
		const b = await open();
		expect(b.queryByText(/Permission prompts/)).toBeNull();
		expect(b.queryByText(/Discarded work/)).toBeNull();
	});

	it("shows the reviews nudge while reviews are off, and dismissing it tells the server", async () => {
		const b = await open();
		expect(b.getByText("Enable reviews for better insights")).toBeTruthy();
		expect(b.getByRole("link", { name: "Enable reviews" }).getAttribute("href")).toBe("/settings#reviews");
		await userEvent.click(b.getByRole("button", { name: "Dismiss tip" }));
		await waitFor(() => expect(screen.queryByText("Enable reviews for better insights")).toBeNull());
		expect(requests.some((r) => r.method === "POST" && r.url.pathname === "/api/nudges/session/dismiss")).toBe(true);
	});

	it("has no nudge when reviews are on, and says there are no findings", async () => {
		detail = sessionDetail("s-1", { review: band({ state: "not_reviewed", findings: [] }) });
		const b = await open();
		expect(b.queryByText("Enable reviews for better insights")).toBeNull();
		expect(b.getByText("No findings for this session")).toBeTruthy();
		expect(b.queryByRole("button", { name: "Dismiss 30d" })).toBeNull();
	});
});

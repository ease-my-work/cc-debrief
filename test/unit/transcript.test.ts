import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { costStateFrom, type StoredLine, sessionTitles, usageFromLines } from "../../src/collector/transcript";
import { FIXTURES, phase0Cases, readExpected, storedLines } from "../helpers/fixtures";

const line = (lineNo: number, payload: Record<string, unknown>, agentId: string | null = null): StoredLine => ({
	lineNo,
	agentId,
	uuid: null,
	type: String(payload.type),
	subtype: null,
	ts: null,
	payload,
});

describe("costStateFrom", () => {
	it("returns the last main-transcript cost-state line of the basic fixture", () => {
		const cs = costStateFrom(storedLines(join(FIXTURES, "synthetic", "basic")));
		expect(cs?.totalCostUsd).toBe(readExpected("basic").costState.totalCostUsd);
		expect(cs?.models["claude-haiku-4-5-20251001"]).toEqual({
			inputTokens: 4,
			outputTokens: 35,
			thinkingTokens: 0,
			cacheReadTokens: 6500,
			cacheCreationTokens: 600,
			costUsd: 0.0234,
		});
	});

	it("returns null without a cost-state line", () => {
		expect(costStateFrom([line(0, { type: "user" })])).toBeNull();
	});

	it("ignores a cost-state line in a subagent transcript", () => {
		expect(costStateFrom([line(0, { type: "cost-state", totalCostUSD: 1, modelUsage: {} }, "a1")])).toBeNull();
	});

	it("matches the file's last cost-state line in every Phase 0 case that covers it", () => {
		const cases = phase0Cases().filter((c) => c.caseJson.covers.includes("cost-state"));
		expect(cases.length).toBeGreaterThan(0);
		for (const { dir } of cases) {
			const lines = storedLines(dir);
			const last = lines.filter((l) => l.agentId === null && l.type === "cost-state").at(-1);
			const cs = costStateFrom(lines);
			expect(cs, dir).not.toBeNull();
			// vscode/windows-api-error: every call failed, so Claude Code itself reports $0.
			if (usageFromLines(lines).length > 0) expect(cs?.totalCostUsd).toBeGreaterThan(0);
			expect(cs?.totalCostUsd).toBe(last?.payload.totalCostUSD);
		}
	});
});

describe("sessionTitles", () => {
	const custom = (n: number, t: unknown, agentId: string | null = null) =>
		line(n, { type: "custom-title", customTitle: t }, agentId);
	const ai = (n: number, t: unknown) => line(n, { type: "ai-title", aiTitle: t });
	const agent = (n: number, a: unknown) => line(n, { type: "agent-name", agentName: a });

	it("takes the last custom-title", () => {
		expect(sessionTitles([custom(1, "First"), custom(5, "Second")])).toEqual({ title: "Second", agentName: null });
	});

	it("falls back to the last ai-title (CLI and VS Code write only these)", () => {
		expect(sessionTitles([ai(1, "One"), ai(2, "Two")]).title).toBe("Two");
		expect(sessionTitles([custom(1, "Mine"), ai(2, "Generated")]).title).toBe("Mine");
	});

	it("orders by lineNo, not array order", () => {
		expect(sessionTitles([custom(9, "Later"), custom(2, "Earlier")]).title).toBe("Later");
	});

	it("reads agent-name alone", () => {
		expect(sessionTitles([agent(1, "helper")])).toEqual({ title: null, agentName: "helper" });
	});

	it("ignores subagent lines, skips non-strings and blanks, collapses whitespace", () => {
		expect(sessionTitles([custom(1, "Main"), custom(2, "Sub", "a1")]).title).toBe("Main");
		expect(sessionTitles([custom(1, "Kept"), custom(2, 42), custom(3, "   ")]).title).toBe("Kept");
		expect(sessionTitles([custom(1, "  Fix   the\ttest ")]).title).toBe("Fix the test");
	});

	it("returns nulls without title lines", () => {
		expect(sessionTitles([line(0, { type: "user" })])).toEqual({ title: null, agentName: null });
	});

	it("reads the basic fixture", () => {
		const { title, agentName } = readExpected("basic").session;
		expect(sessionTitles(storedLines(join(FIXTURES, "synthetic", "basic")))).toEqual({ title, agentName });
	});
});

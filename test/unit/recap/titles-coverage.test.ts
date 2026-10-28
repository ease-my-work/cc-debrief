// Phase 6 Task 1: the recap's first bullet source, sessions.title, is filled by Phase 1's derive for every Phase 0
// fixture that carries a title line; slimLine() keeps the three line types unchanged.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setConfigValue } from "../../../src/config";
import type { Db } from "../../../src/db/adapter";
import { ingestPending } from "../../../src/ingest/ingest";
import { slimLine } from "../../../src/ingest/line";
import { copyFixtureInto, loadFixtureCases } from "../../helpers/fixtures";
import { seedDb } from "../../helpers/seed";
import { type TmpHome, tmpHome } from "../../helpers/tmp-home";

let h: TmpHome;
let db: Db;
// Read-only tests: one ingest of every fixture for the file.
beforeAll(() => {
	h = tmpHome();
	setConfigValue("retention.days", "0"); // fixture timestamps age; never skip them
	db = seedDb();
	for (const c of loadFixtureCases()) copyFixtureInto(h.claude, c.caseDir);
	ingestPending(db);
});
afterAll(() => {
	db.close();
	h.cleanup();
});

/** The last value of `field` on lines of `type` in the case's main transcript. */
function lastLine(caseDir: string, sessionId: string, type: string, field: string): string | null {
	let out: string | null = null;
	for (const raw of readFileSync(join(caseDir, `${sessionId}.jsonl`), "utf8").split("\n")) {
		if (!raw.trim()) continue;
		const line = JSON.parse(raw) as Record<string, unknown>;
		if (line.type === type && typeof line[field] === "string") out = line[field] as string;
	}
	return out;
}
const row = (id: string) =>
	db.prepare("SELECT title, agent_name FROM sessions WHERE session_id = ?").get<{
		title: string | null;
		agent_name: string | null;
	}>(id);

describe("title coverage over the Phase 0 fixtures", () => {
	const cases = loadFixtureCases();
	const titled = cases.filter((c) => c.caseJson.covers.some((x) => x === "custom-title" || x === "ai-title"));

	it("covers desktop custom-title and CLI / VS Code ai-title cases", () => {
		expect(titled.map((c) => c.surface).sort()).toEqual(expect.arrayContaining(["cli", "desktop", "vscode"]));
	});

	for (const c of titled) {
		it(`${c.surface}/${c.caseDir.split(/[\\/]/).pop()}: title from the last ${c.caseJson.covers.includes("custom-title") ? "custom-title" : "ai-title"}`, () => {
			const expected =
				lastLine(c.caseDir, c.sessionId, "custom-title", "customTitle") ??
				lastLine(c.caseDir, c.sessionId, "ai-title", "aiTitle");
			expect(expected).not.toBeNull();
			expect(row(c.sessionId)?.title).toBe(expected);
		});
	}

	it("desktop windows-scenario-s takes its agent name from the last agent-name line", () => {
		const c = cases.find((x) => x.surface === "desktop" && x.caseJson.covers.includes("agent-name"));
		if (!c) throw new Error("no desktop agent-name fixture");
		expect(row(c.sessionId)?.agent_name).toBe(lastLine(c.caseDir, c.sessionId, "agent-name", "agentName"));
	});

	it("windows-after-clear has no title line and no title", () => {
		const c = cases.find((x) => x.caseDir.endsWith("windows-after-clear"));
		if (!c) throw new Error("no windows-after-clear fixture");
		expect(lastLine(c.caseDir, c.sessionId, "ai-title", "aiTitle")).toBeNull();
		expect(lastLine(c.caseDir, c.sessionId, "custom-title", "customTitle")).toBeNull();
		expect(row(c.sessionId)?.title).toBeNull();
	});
});

describe("slimLine keeps the title lines", () => {
	it.each([
		{ type: "custom-title", customTitle: "Add rate limiting", sessionId: "s", cwd: "/x" },
		{ type: "ai-title", aiTitle: "Fix the flaky test", sessionId: "s" },
		{ type: "agent-name", agentName: "feat/ingest", sessionId: "s", cwd: "/x" },
	])("$type round trip is unchanged", (line) => {
		expect(slimLine(structuredClone(line))).toEqual(line);
	});
});

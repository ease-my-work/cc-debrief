import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listTranscripts, readSubagentMeta } from "../../src/ingest/files";
import { writeTranscript } from "../helpers/fixtures";
import { type TmpHome, tmpHome } from "../helpers/tmp-home";

const SID = "5b1c0d2e-3f4a-4b5c-8d6e-7f8091a2b3c4";
const LINE = { type: "user", message: { content: "hi" } };

let t: TmpHome;
beforeEach(() => {
	t = tmpHome();
});
afterEach(() => t.cleanup());

describe("listTranscripts", () => {
	it("finds main and subagent transcripts and ignores everything else", () => {
		const main = writeTranscript(t.claude, "-home-user-p", SID, [LINE]);
		const sub = writeTranscript(t.claude, "-home-user-p", SID, [LINE, LINE], {
			agentId: "a1b2c3",
			meta: { agentType: "Explore" },
		});
		const project = join(t.claude, "projects", "-home-user-p");
		mkdirSync(join(project, "memory"));
		writeFileSync(join(project, "memory", "MEMORY.md"), "# notes\n");
		writeFileSync(join(project, "stray.txt"), "x");
		writeFileSync(join(project, "bad name.jsonl"), "{}\n");
		mkdirSync(join(project, SID, "tool-results"));
		writeFileSync(join(project, SID, "tool-results", "x.jsonl"), "{}\n");
		writeFileSync(join(t.claude, "projects", "top-level.jsonl"), "{}\n");

		const files = listTranscripts();
		expect(files.map(({ path, sessionId, agentId }) => ({ path, sessionId, agentId }))).toEqual([
			{ path: main, sessionId: SID, agentId: null },
			{ path: sub, sessionId: SID, agentId: "a1b2c3" },
		]);
		expect(files[0].size).toBe(JSON.stringify(LINE).length + 1);
		expect(files[1].size).toBe(2 * (JSON.stringify(LINE).length + 1));
		expect(files[0].mtimeMs).toBeGreaterThan(0);
	});

	it("filters on mtime with since", () => {
		const old = writeTranscript(t.claude, "p", SID, [LINE]);
		const fresh = writeTranscript(t.claude, "p", "0b7c3f5e-1111-4222-8333-944455556666", [LINE]);
		const twoHoursAgo = new Date(Date.now() - 2 * 3600_000);
		utimesSync(old, twoHoursAgo, twoHoursAgo);
		const since = new Date(Date.now() - 3600_000);
		expect(listTranscripts({ since }).map((f) => f.path)).toEqual([fresh]);
		expect(listTranscripts()).toHaveLength(2);
	});

	it("returns nothing, without throwing, when projects/ is missing", () => {
		process.env.CLAUDE_CONFIG_DIR = join(t.claude, "does-not-exist");
		expect(listTranscripts()).toEqual([]);
	});
});

describe("readSubagentMeta", () => {
	it("reads agentType, description and toolUseId from the .meta.json beside the transcript", () => {
		writeTranscript(t.claude, "p", SID, [LINE], {
			agentId: "a1",
			meta: { agentType: "Explore", description: "List files", toolUseId: "toolu_1", spawnDepth: 1 },
		});
		const [file] = listTranscripts();
		expect(readSubagentMeta(file)).toEqual({ agentType: "Explore", description: "List files", toolUseId: "toolu_1" });
	});

	it("returns null when the meta file is missing or invalid, and for a main transcript", () => {
		writeTranscript(t.claude, "p", SID, [LINE]);
		const sub = writeTranscript(t.claude, "p", SID, [LINE], { agentId: "a1" });
		const files = listTranscripts();
		expect(readSubagentMeta(files[0])).toBeNull();
		expect(readSubagentMeta(files[1])).toBeNull();
		writeFileSync(sub.replace(/\.jsonl$/, ".meta.json"), "{ nope");
		expect(readSubagentMeta(files[1])).toBeNull();
	});

	it("drops non-string fields", () => {
		writeTranscript(t.claude, "p", SID, [LINE], { agentId: "a1", meta: { agentType: 5, description: "d" } });
		expect(readSubagentMeta(listTranscripts()[0])).toEqual({ description: "d" });
	});
});

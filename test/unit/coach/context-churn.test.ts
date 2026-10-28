import { describe, expect, it } from "vitest";
import { contextChurn } from "../../../src/coach/signals/context-churn";
import { call, ctx } from "../../helpers/ctx";

const read = (path: string, turn: number, bytes: number, extra: Record<string, unknown> = {}, agentId?: string) =>
	call("Read", { file_path: path, ...extra }, { turn, bytes, agentId });

describe("context_churn", () => {
	it("fires on 4 reads of one file (offset ignored) with the basename, read 2-4 cost and evidence", () => {
		const c = ctx({
			toolCalls: [
				read("/r/src/a.ts", 1, 4000),
				read("/r/src/a.ts", 2, 401),
				read("/r/src/a.ts", 3, 800, { offset: 100, limit: 50 }),
				call("Edit", { file_path: "/r/src/a.ts" }, { turn: 3 }),
				read("/r/src/a.ts", 5, 7),
			],
		});
		expect(contextChurn.detect(c)).toEqual([
			{
				rule: "context_churn",
				severity: "low",
				message: "`a.ts` read 4 times — pin key facts in CLAUDE.md or keep sessions shorter",
				evidence: { key: "/r/src/a.ts", file: "/r/src/a.ts", count: 4, turns: [1, 2, 3, 5] },
				costTokens: 101 + 200 + 2,
				target: "session",
			},
		]);
	});

	it("does not fire on 3 reads", () => {
		const c = ctx({ toolCalls: [1, 2, 3].map((t) => read("/r/a.ts", t, 100)) });
		expect(contextChurn.detect(c)).toEqual([]);
	});

	it("is medium at 8 reads", () => {
		const c = ctx({ toolCalls: [1, 2, 3, 4, 5, 6, 7, 8].map((t) => read("/r/a.ts", t, 100)) });
		const [f] = contextChurn.detect(c);
		expect(f.severity).toBe("medium");
		expect(f.evidence.count).toBe(8);
	});

	it("normalises Windows separators and drive-letter case to one file", () => {
		const c = ctx({
			toolCalls: [
				read("C:\\r\\src\\a.ts", 1, 10),
				read("C:/r/src/a.ts", 2, 10),
				read("c:\\r\\src\\a.ts", 3, 10),
				read("C:/r/src/a.ts", 4, 10),
			],
		});
		const [f] = contextChurn.detect(c);
		expect(f.evidence).toMatchObject({ key: "c:/r/src/a.ts", file: "C:/r/src/a.ts", count: 4 });
		expect(f.message).toContain("`a.ts`");
	});

	it("counts reads by a subagent and ignores denied reads", () => {
		const c = ctx({
			toolCalls: [
				read("/r/a.ts", 1, 10),
				read("/r/a.ts", 1, 10, {}, "ag1"),
				read("/r/a.ts", 2, 10, {}, "ag1"),
				call("Read", { file_path: "/r/a.ts" }, { turn: 3, ok: false, denied: "user" }),
			],
		});
		expect(contextChurn.detect(c)).toEqual([]);
		c.toolCalls.push(read("/r/a.ts", 4, 10));
		expect(contextChurn.detect(c)[0].evidence.count).toBe(4);
	});

	it("gives one finding per churned file", () => {
		const c = ctx({
			toolCalls: [1, 2, 3, 4].flatMap((t) => [read("/r/a.ts", t, 10), read("/r/b.ts", t, 10)]),
		});
		expect(contextChurn.detect(c).map((f) => f.evidence.key)).toEqual(["/r/a.ts", "/r/b.ts"]);
	});
});

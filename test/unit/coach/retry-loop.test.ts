import { describe, expect, it } from "vitest";
import { retryLoop } from "../../../src/coach/signals/retry-loop";
import type { ContextToolCall } from "../../../src/coach/types";
import { at, call, ctx, usage } from "../../helpers/ctx";

/** A shell call at minute `min` of the session (1 turn per 3 minutes). */
const sh = (command: string, min: number, ok: boolean, o: { tool?: string; denied?: string; exit?: number } = {}) =>
	call(
		o.tool ?? "Bash",
		{ command },
		{
			ok: o.denied ? false : ok,
			denied: o.denied ?? null,
			exitCode: ok || o.denied ? null : (o.exit ?? 1),
			at: at(min),
			ms: 30_000,
			turn: Math.floor(min / 3) + 1,
		},
	);
const edit = (min: number) => call("Edit", { file_path: "/r/a.ts" }, { at: at(min), turn: Math.floor(min / 3) + 1 });

/** 100 tokens of usage every minute for 30 minutes: 3000 session tokens. */
const minuteUsage = () =>
	Array.from({ length: 30 }, (_, m) => usage(Math.floor(m / 3) + 1, { input: 100, ts: at(m, 50) }));

const detect = (calls: ContextToolCall[]) => retryLoop.detect(ctx({ toolCalls: calls, usage: minuteUsage() }));

describe("retry_loop", () => {
	it("fires once for npm test failing 3 times with edits between, then passing", () => {
		const findings = detect([
			sh("npm test", 1, false),
			edit(2),
			sh("npm test -- -u", 3, false, { exit: 2 }),
			edit(4),
			sh("npm test", 5, false),
			edit(6),
			sh("npm test", 7, true),
		]);
		// usage from minute 1:00 (first failure start) to 7:30 (closing call end): minutes 1..6 at :50 → 6 rows
		expect(findings).toEqual([
			{
				rule: "retry_loop",
				severity: "medium",
				message: "npm test failed 3 times before passing — 20% of session tokens",
				// firstTurn / lastTurn: the turns of the first and last failure
				evidence: { key: "npm test", count: 3, exitCodes: [1, 2, 1], firstTurn: 1, lastTurn: 2, passed: true, pct: 20 },
				costTokens: 600,
				target: "session",
			},
		]);
	});

	it("counts non-cached tokens only: cache reads change neither cost nor share", () => {
		const rows = Array.from({ length: 30 }, (_, m) =>
			usage(Math.floor(m / 3) + 1, { input: 60, cacheCreation: 30, output: 10, cacheRead: 5000, ts: at(m, 50) }),
		);
		const calls = [
			sh("npm test", 1, false),
			sh("npm test", 3, false),
			sh("npm test", 5, false),
			sh("npm test", 7, true),
		];
		const [f] = retryLoop.detect(ctx({ toolCalls: calls, usage: rows }));
		expect(f).toMatchObject({ costTokens: 600, evidence: { pct: 20 } });
	});

	it("is high at 25% of session tokens or more", () => {
		const [f] = detect([sh("pytest", 1, false), sh("pytest", 4, false), sh("pytest", 8, false), sh("pytest", 9, true)]);
		// 1:00 to 9:30 holds the rows at 1:50 … 8:50: 800 of 3000 tokens
		expect(f.evidence.pct).toBe(27);
		expect(f.severity).toBe("high");
	});

	it("treats PowerShell like Bash (the Windows shape) with exit codes in the evidence", () => {
		const [f] = detect([
			sh("npm test", 1, false, { tool: "PowerShell" }),
			sh("npm test", 2, false, { tool: "PowerShell" }),
			sh("npm test", 3, false, { tool: "PowerShell", exit: 3 }),
			sh("npm test", 4, true, { tool: "PowerShell" }),
		]);
		expect(f.evidence).toMatchObject({ key: "npm test", count: 3, exitCodes: [1, 1, 3], passed: true });
	});

	it("does not fire on 2 failures then a pass", () => {
		expect(detect([sh("npm test", 1, false), sh("npm test", 2, false), sh("npm test", 3, true)])).toEqual([]);
	});

	it("reports a streak that never passes", () => {
		const [f] = detect([sh("npm test", 1, false), sh("npm test", 2, false), sh("npm test", 3, false)]);
		expect(f.message).toBe("npm test failed 3 times in a row without passing — 7% of session tokens");
		expect(f.evidence.passed).toBe(false);
		// 1:00 to the last failure's end (3:30) holds the rows at 1:50 and 2:50
		expect(f.costTokens).toBe(200);
	});

	it("keys other tools by name and primary target", () => {
		const read = (min: number, ok: boolean) =>
			call("Read", { file_path: "a.ts" }, { ok, at: at(min), turn: Math.floor(min / 3) + 1 });
		const [f] = detect([read(1, false), read(2, false), read(3, false)]);
		expect(f.evidence.key).toBe("Read a.ts");
	});

	it("keys interleaved failures separately: A, B, A, B, A, B gives two findings", () => {
		const findings = detect([
			sh("npm test", 1, false),
			sh("pytest", 2, false),
			sh("npm test", 3, false),
			sh("pytest", 4, false),
			sh("npm test", 5, false),
			sh("pytest", 6, false),
		]);
		expect(findings.map((f) => [f.evidence.key, f.evidence.count])).toEqual([
			["npm test", 3],
			["pytest", 3],
		]);
	});

	it("starts a new streak after a pass: A fails, A passes, A fails ×3 gives one finding", () => {
		const findings = detect([
			sh("npm test", 1, false),
			sh("npm test", 2, true),
			sh("npm test", 3, false),
			sh("npm test", 4, false),
			sh("npm test", 5, false),
		]);
		expect(findings).toHaveLength(1);
		expect(findings[0].evidence).toMatchObject({ count: 3, firstTurn: 2, passed: false });
	});

	it("ignores denied calls: they neither extend nor break a streak", () => {
		expect(
			detect([
				sh("npm test", 1, false, { denied: "user" }),
				sh("npm test", 2, false, { denied: "user" }),
				sh("npm test", 3, false, { denied: "classifier" }),
			]),
		).toEqual([]);
		const [f] = detect([
			sh("npm test", 1, false),
			sh("npm test", 2, false, { denied: "user" }),
			sh("npm test", 3, false),
			sh("npm test", 4, false, { denied: "user" }),
			sh("npm test", 5, false),
		]);
		expect(f.evidence.count).toBe(3);
	});

	it("keeps findings unique per key when one key has two streaks", () => {
		const findings = detect([
			...[1, 2, 3].map((m) => sh("npm test", m, false)),
			sh("npm test", 4, true),
			...[5, 6, 7].map((m) => sh("npm test", m, false)),
		]);
		expect(findings.map((f) => f.evidence.key)).toEqual(["npm test", "npm test #2"]);
		expect(findings[1].message.startsWith("npm test failed 3 times")).toBe(true);
	});

	it("costs 0 and pct 0 without usage rows", () => {
		const [f] = retryLoop.detect(
			ctx({
				toolCalls: [sh("npm test", 1, false), sh("npm test", 2, false), sh("npm test", 3, false)],
				usage: [],
			}),
		);
		expect(f).toMatchObject({ costTokens: 0, severity: "medium", evidence: { pct: 0 } });
	});
});

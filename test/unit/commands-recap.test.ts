// Phase 6 Task 7: `cc-debrief recap` (feature 13). Date is faked to the fixture's 18:00 local, so "today" is
// RECAP_DAY; the fake `claude` proves no run without --polish spawns anything.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { runRecap } from "../../src/commands/recap";
import { FAKE_RECAP, type FakeClaude, fakeClaude, successResult } from "../helpers/fake-claude";
import { LEAK_DIR, LEAK_TOKEN, RECAP_NOW, seedRecapFixture } from "../helpers/recap-seed";
import { runCaptured } from "../helpers/run-cli";
import { seedDb } from "../helpers/seed";
import { type TmpHome, tmpHome } from "../helpers/tmp-home";

let h: TmpHome;
let fake: FakeClaude;
let restore: () => void;
/** Calls the fake `claude` may receive in this test (only --polish tests set it). */
let allowedCalls = 0;
beforeEach(() => {
	h = tmpHome();
	fake = fakeClaude(h.home);
	restore = fake.install();
	const db = seedDb();
	seedRecapFixture(db);
	db.close();
	vi.useFakeTimers({ now: RECAP_NOW, toFake: ["Date"] });
	allowedCalls = 0;
});
afterEach(() => {
	vi.useRealTimers();
	expect(fake.calls()).toHaveLength(allowedCalls); // only --polish spawns claude, once
	restore();
	h.cleanup();
});

const golden = (name: string) => readFileSync(join(import.meta.dirname, "..", "fixtures", "recap", name), "utf8");
const recap = (...args: string[]) => runCaptured("recap", "--no-ingest", ...args);
const firstLine = (s: string) => s.split("\n")[0];

const Bullet = z.object({
	text: z.string(),
	source: z.enum(["title", "summary", "agent_name", "files", "explored"]),
	files: z.array(z.string()),
	moreFiles: z.number().int(),
	sessionIds: z.array(z.string()).min(1),
	firstTurnAt: z.string(),
});
const Group = z.object({
	repo: z.string(),
	repoId: z.string().nullable(),
	turns: z.number().int(),
	bullets: z.array(Bullet),
});
const RecapSchema = z.strictObject({
	range: z.object({ from: z.string(), to: z.string() }),
	groupBy: z.enum(["repo", "day"]),
	groups: z.array(Group),
	days: z.array(z.object({ date: z.string(), groups: z.array(Group) })),
	hiddenRepos: z.number().int(),
	sessions: z.number().int(),
	retentionCutoff: z.string().nullable(),
	retentionDays: z.number().int(),
	activity: z.array(z.object({ date: z.string(), slots: z.array(z.number().int()).length(96) })),
});

describe("cc-debrief recap", () => {
	it("no flags prints today's recap (the day golden)", async () => {
		const r = await recap();
		expect(r.code).toBe(0);
		expect(r.stdout).toBe(golden("day.txt"));
		expect(r.stderr).toBe("");
	});

	it.each([
		[["--yesterday"], "Sun, Sep 27 2026"],
		[["--today"], "Mon, Sep 28 2026"],
		[["--date=2026-09-27"], "Sun, Sep 27 2026"],
		[["--week"], "Tue, Sep 22 – Mon, Sep 28 2026"],
		[["--from=2026-09-26", "--to=2026-09-27"], "Sat, Sep 26 – Sun, Sep 27 2026"],
		[["--from=2026-09-26"], "Sat, Sep 26 – Mon, Sep 28 2026"],
	])("%j selects the right days", async (args, header) => {
		const r = await recap(...args);
		expect(r.code).toBe(0);
		expect(firstLine(r.stdout)).toBe(header);
	});

	it("--week matches the week golden; --by-day the by-day golden", async () => {
		expect((await recap("--week")).stdout).toBe(golden("week-repo.txt"));
		expect((await recap("--week", "--by-day")).stdout).toBe(golden("week-day.txt"));
		expect((await recap("--week", "--markdown")).stdout).toBe(golden("week-repo.md"));
	});

	it.each([
		[["--week", "--date=2026-09-11"], "use one of --today, --yesterday, --date, --week, --from"],
		[["--today", "--yesterday"], "use one of --today, --yesterday, --date, --week, --from"],
		[["--to=2026-09-11"], "use one of --today, --yesterday, --date, --week, --from"],
		[["--date=2026-13-01"], 'invalid date "2026-13-01"'],
		[["--from=2026-09-10", "--to=2026-09-01"], "from is after to"],
		[["--markdown", "--json"], "use one of --markdown, --json"],
	])("%j exits 2", async (args, message) => {
		const r = await recap(...args);
		expect(r.code).toBe(2);
		expect(r.stderr).toBe(`error: ${message}\n`);
		expect(r.stdout).toBe("");
	});

	it("an empty day exits 0 with the empty line", async () => {
		const r = await recap("--date=2026-09-20");
		expect(r.code).toBe(0);
		expect(r.stdout).toBe("No work recorded for Sun, Sep 20 2026.\n");
	});

	it("--no-files drops every file line", async () => {
		const r = await recap("--no-files");
		expect(r.stdout).not.toContain("errors.go");
		expect(r.stdout).toContain("Add rate limiting to the public endpoints");
	});

	it("--json prints a Recap", async () => {
		const r = await recap("--json", "--by-day", "--week");
		const parsed = RecapSchema.parse(JSON.parse(r.stdout));
		expect(parsed.groupBy).toBe("day");
		expect(parsed.days.map((d) => d.date)).toEqual(["2026-09-27", "2026-09-28"]);
	});

	it("never prints prompt text or a directory", async () => {
		for (const args of [[], ["--week", "--by-day"], ["--json"], ["--markdown"]]) {
			const out = (await recap(...args)).stdout;
			expect(out).not.toContain(LEAK_TOKEN);
			expect(out).not.toContain(LEAK_DIR);
			expect(out).not.toContain("/home/u");
		}
	});
});

describe("cc-debrief recap --polish", () => {
	it("prints the estimate to stderr, then the polished recap", async () => {
		allowedCalls = 1;
		fake.scenario({ stdout: successResult(FAKE_RECAP) });
		const r = await recap("--polish");
		expect(r.code).toBe(0);
		expect(r.stderr).toMatch(/^polishing with one claude -p call \((~\$[0-9.]+|cost unknown)\)\n$/);
		expect(r.stdout).toBe(
			"Mon, Sep 28 2026\n\ncheckout-flow\n  • Debugged the failed webhook retry\n  • Reworked the cart page\n\napi-gateway\n  • Added rate limiting to the public endpoints\n",
		);
		expect(fake.invocations()[0].stdin).not.toContain(LEAK_TOKEN);
	});

	it("--polish --json prints a PolishedRecap", async () => {
		allowedCalls = 1;
		fake.scenario({ stdout: successResult(FAKE_RECAP) });
		const p = JSON.parse((await recap("--polish", "--json")).stdout) as { groups: unknown; costUsd: unknown };
		expect(p.groups).toEqual(FAKE_RECAP.groups);
		expect(typeof p.costUsd).toBe("number");
	});

	it("a failure prints the deterministic recap, then the reason, and exits 1", async () => {
		allowedCalls = 1;
		fake.scenario({ stdout: successResult({ groups: [{ repo: "made-up", items: ["x"] }] }) });
		const r = await recap("--polish");
		expect(r.code).toBe(1);
		expect(r.stdout).toBe(golden("day.txt"));
		expect(r.stderr.split("\n").filter(Boolean).pop()).toBe("error: polish failed: schema");
	});

	it("an empty range makes no call", async () => {
		const r = await recap("--polish", "--date=2026-09-20");
		expect(r.code).toBe(0);
		expect(r.stdout).toBe("No work recorded for Sun, Sep 20 2026.\n");
	});
});

describe("runRecap ingest", () => {
	it("ingests first unless --no-ingest", async () => {
		const ingest = vi.fn();
		const out: string[] = [];
		await runRecap({ ingest, out: (l) => out.push(l) });
		expect(ingest).toHaveBeenCalledTimes(1);
		await runRecap({ noIngest: true, ingest, out: (l) => out.push(l) });
		expect(ingest).toHaveBeenCalledTimes(1);
	});

	it("the default ingest runs without claude -p", async () => {
		const r = await runCaptured("recap");
		expect(r.code).toBe(0);
		expect(r.stdout).toBe(golden("day.txt"));
	});
});

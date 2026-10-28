// Phase 7 Task 16 (P15): `cc-debrief digest` — spend and change, top repos, budget pace, spikes, cache hit rate and
// the coaching items, as text, Markdown or JSON, with no AI call. Date is faked to PARITY_NOW.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { updateConfig } from "../../src/config";
import { type FakeClaude, fakeClaude } from "../helpers/fake-claude";
import {
	LEAK_FOLDER,
	LEAK_PROMPT,
	localAt,
	PARITY_NOW,
	REPO_A,
	REPO_B,
	seedParitySession,
} from "../helpers/parity-seed";
import { runCaptured } from "../helpers/run-cli";
import { seedDb } from "../helpers/seed";
import { type TmpHome, tmpHome } from "../helpers/tmp-home";

let h: TmpHome;
let fake: FakeClaude;
let restore: () => void;
beforeEach(() => {
	h = tmpHome();
	fake = fakeClaude(h.home);
	restore = fake.install();
	const db = seedDb();
	seedParitySession(db, "s1", {
		startedAt: localAt(1, 10),
		repo: { ...REPO_A, root: `/home/u/${LEAK_FOLDER}/api` },
		cwd: `/home/u/${LEAK_FOLDER}/api`,
		prompt: `please ${LEAK_PROMPT}`,
		usage: [{ input: 1000, cacheRead: 3000, cost: 2 }],
	});
	seedParitySession(db, "s2", { startedAt: localAt(2, 10), repo: REPO_A, usage: [{ input: 1000, cost: 3 }] });
	seedParitySession(db, "s3", { startedAt: localAt(3, 10), repo: REPO_B, usage: [{ input: 1000, cost: 1 }] });
	seedParitySession(db, "s4", { startedAt: localAt(10, 10), repo: REPO_A, usage: [{ input: 1000, cost: 4 }] });
	db.close();
	updateConfig({ set: { "budget.monthlyUsd": 100 } });
	vi.useFakeTimers({ now: PARITY_NOW, toFake: ["Date"] });
});
afterEach(() => {
	vi.useRealTimers();
	expect(fake.calls()).toHaveLength(0); // never an AI call
	restore();
	h.cleanup();
});

const golden = (name: string) => readFileSync(join(import.meta.dirname, "..", "fixtures", "digest", name), "utf8");
const digest = (...args: string[]) => runCaptured("digest", "--no-ingest", ...args);

describe("cc-debrief digest", () => {
	it("prints the 7-day text digest by default", async () => {
		const r = await digest();
		expect(r.code).toBe(0);
		expect(r.stdout).toBe(golden("week.txt"));
		expect(r.stdout.endsWith("\n\n")).toBe(false);
	});

	it("--format md matches the Markdown golden", async () => {
		expect((await digest("--format", "md")).stdout).toBe(golden("week.md"));
	});

	it("--format json has the same facts", async () => {
		const r = await digest("--format", "json");
		const j = JSON.parse(r.stdout);
		expect(j).toMatchObject({
			days: 7,
			since: "2026-10-10",
			spend: { usd: 6, previousUsd: 4, changePct: 50 },
			sessions: 3,
			cacheHitPct: 50,
			topRepos: [
				{ name: "api", usd: 5 },
				{ name: "web", usd: 1 },
			],
			budget: { budgetUsd: 100, monthToDateUsd: 10, projectedUsd: 18.235294, level: "ok", daysLeft: 14 },
			spikes: [],
			coaching: [],
		});
	});

	it("--days 30 covers 30 days and compares with the 30 before", async () => {
		const j = JSON.parse((await digest("--days", "30", "--format", "json")).stdout);
		expect(j).toMatchObject({ days: 30, spend: { usd: 10, previousUsd: 0, changePct: null }, sessions: 4 });
		expect((await digest("--days", "30")).stdout.split("\n")[1]).toBe(
			"Spend: $10.00 · no spend the 30 days before · 4 sessions",
		);
	});

	it("--repo limits spend and top repos to one repo", async () => {
		const j = JSON.parse((await digest("--repo", REPO_B.id, "--format", "json")).stdout);
		expect(j).toMatchObject({ repo: "web", spend: { usd: 1 }, topRepos: [{ name: "web", usd: 1 }] });
	});

	it.each([["--days", "14"], ["--format", "html"], ["--bogus"]])("exits 2 on %s", async (...args) => {
		const r = await digest(...args);
		expect(r.code).toBe(2);
	});

	it("never prints prompt text or a full path, in any format", async () => {
		for (const format of ["text", "md", "json"]) {
			const out = (await digest("--format", format)).stdout;
			expect(out).not.toContain(LEAK_PROMPT);
			expect(out).not.toContain(LEAK_FOLDER);
		}
	});
});

describe("cc-debrief digest spikes and coaching", () => {
	it("lists spend spikes and the coaching items", async () => {
		const db = seedDb();
		for (let i = 0; i < 14; i++)
			seedParitySession(db, `u${i}`, { startedAt: localAt(8 + i, 9), usage: [{ input: 10, cost: 1 }] });
		seedParitySession(db, "spike", { startedAt: localAt(0, 9), repo: REPO_A, usage: [{ input: 10, cost: 9 }] });
		db.prepare(
			`INSERT INTO findings (session_id, rule, subject_key, severity, message, evidence, cost_tokens, created_at)
			 VALUES (NULL, 'model_mix', 'k', 'medium', 'Opus on light sessions in api', '{"target":"session"}', 5000, ?)`,
		).run(localAt(1, 12));
		db.close();
		const lines = (await digest()).stdout.split("\n");
		const day = new Date(2026, 9, 17);
		expect(lines).toContain(
			`  ${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][day.getDay()]} Oct 17 $9.00 (usual $1.00)`,
		);
		expect(lines).toContain("  - [medium] Opus on light sessions in api");
	});
});

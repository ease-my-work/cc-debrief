// Phase 6 Task 6: text and Markdown formatters against golden files (test/fixtures/recap; each ends with one newline,
// the formatter's output with none).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../../../src/config";
import type { Db } from "../../../src/db/adapter";
import { buildRecap } from "../../../src/recap/build";
import { formatMarkdown, formatRepo, formatText, rangeLabel } from "../../../src/recap/format";
import type { PolishedRecap, Recap } from "../../../src/recap/types";
import { RECAP_DAY, RECAP_NOW, seedRecapFixture } from "../../helpers/recap-seed";
import { seedDb } from "../../helpers/seed";
import { type TmpHome, tmpHome } from "../../helpers/tmp-home";

let h: TmpHome;
let db: Db;
beforeEach(() => {
	h = tmpHome();
	db = seedDb();
});
afterEach(() => {
	db.close();
	h.cleanup();
});

const golden = (name: string) => readFileSync(join(import.meta.dirname, "..", "..", "fixtures", "recap", name), "utf8");
const WEEK = { from: "2026-09-22", to: RECAP_DAY };
const DAY = { from: RECAP_DAY, to: RECAP_DAY };
const build = (range: { from: string; to: string }, groupBy: "repo" | "day" = "repo") =>
	buildRecap(db, ConfigSchema.parse({}), { range, groupBy, files: true, now: RECAP_NOW });
const POLISHED: PolishedRecap = {
	range: DAY,
	groups: [
		{
			repo: "api-gateway",
			items: ["Added rate limiting to the public endpoints", "Fixed the flaky auth integration test"],
		},
		{ repo: "checkout-flow", items: ["Debugged the failed webhook retry"] },
	],
	costUsd: 0.012,
};

describe("formatText / formatMarkdown goldens", () => {
	const cases: [string, () => Recap | PolishedRecap][] = [
		["day", () => build(DAY)],
		["week-repo", () => build(WEEK)],
		["week-day", () => build(WEEK, "day")],
		["empty", () => build(WEEK)],
		["polished", () => POLISHED],
	];
	for (const [name, make] of cases) {
		it(`${name}.txt and ${name}.md byte for byte`, () => {
			if (name !== "empty") seedRecapFixture(db);
			const r = make();
			expect(`${formatText(r)}\n`).toBe(golden(`${name}.txt`));
			expect(`${formatMarkdown(r)}\n`).toBe(golden(`${name}.md`));
		});
	}

	it("no carriage returns and no trailing blank line", () => {
		seedRecapFixture(db);
		for (const r of [build(DAY), build(WEEK, "day"), POLISHED]) {
			for (const out of [formatText(r), formatMarkdown(r)]) {
				expect(out).not.toContain("\r");
				expect(out.endsWith("\n")).toBe(false);
			}
		}
	});
});

describe("headers and empty lines", () => {
	it("a range across years names both", () =>
		expect(rangeLabel({ from: "2026-12-28", to: "2027-01-03" })).toBe("Mon, Dec 28 2026 – Sun, Jan 3 2027"));
	it("an empty range older than the retention window says so", () => {
		const r = build({ from: "2026-01-05", to: "2026-01-05" });
		expect(formatText(r)).toBe("No work recorded for Mon, Jan 5 2026 (older than the 90-day retention window).");
		expect(formatMarkdown(r)).toBe("No work recorded for Mon, Jan 5 2026 (older than the 90-day retention window).");
	});
	it("an empty range inside the window does not", () =>
		expect(formatText(build(DAY))).toBe("No work recorded for Mon, Sep 28 2026."));
});

describe("Markdown text", () => {
	it("escapes *, _ and ` in bullet text; a repo name with spaces is unchanged", () => {
		const r: PolishedRecap = {
			range: DAY,
			groups: [{ repo: "my repo", items: ["Fix `parse_args` *now*"] }],
			costUsd: null,
		};
		expect(formatMarkdown(r)).toBe("## Mon, Sep 28 2026\n\n### my repo\n\n- Fix \\`parse\\_args\\` \\*now\\*");
		expect(formatText(r)).toBe("Mon, Sep 28 2026\n\nmy repo\n  • Fix `parse_args` *now*");
	});
});

describe("formatRepo", () => {
	it("one group with the range header", () => {
		seedRecapFixture(db);
		const r = build(DAY);
		expect(formatRepo(r, "scratch", "text")).toBe("Mon, Sep 28 2026\n\nscratch\n  • Try a parser idea");
		expect(formatRepo(r, "scratch", "markdown")).toBe("## Mon, Sep 28 2026\n\n### scratch\n\n- Try a parser idea");
	});
	it("by day: the repo under each day it appears", () => {
		seedRecapFixture(db);
		const r = build(WEEK, "day");
		expect(formatRepo(r, "notes", "text")).toBe(
			"Sun, Sep 27 2026\n\nnotes\n  • Fix the export bug\n    export.ts\n\nMon, Sep 28 2026\n\nnotes\n  • Fix the export bug\n    export.test.ts\n  • read README.md, plan.md +1",
		);
	});
	it("an unknown repo is empty", () => {
		seedRecapFixture(db);
		expect(formatRepo(build(DAY), "nope", "text")).toBe("");
	});
});

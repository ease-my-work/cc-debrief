// Phase 6 Task 5: work filter, hidden repos, worktree folding, bullet sources, dedupe and file lines.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Config, ConfigSchema } from "../../../src/config";
import type { Db } from "../../../src/db/adapter";
import { buildRecap, bulletFor } from "../../../src/recap/build";
import type { Recap, RecapBullet, RecapGroup } from "../../../src/recap/types";
import {
	at,
	LEAK_DIR,
	LEAK_TOKEN,
	RECAP_DAY,
	RECAP_NOW,
	RECAP_PREV,
	seedRecapFixture,
	seedRecapSession,
} from "../../helpers/recap-seed";
import { seedDb } from "../../helpers/seed";
import { type TmpHome, tmpHome } from "../../helpers/tmp-home";

let h: TmpHome;
let db: Db;
beforeEach(() => {
	h = tmpHome();
	db = seedDb();
	seedRecapFixture(db);
});
afterEach(() => {
	db.close();
	h.cleanup();
});

const cfg = (over: { hiddenRepos?: string[]; retentionDays?: number } = {}): Config => {
	const c = ConfigSchema.parse({});
	return {
		...c,
		recap: { hiddenRepos: over.hiddenRepos ?? [] },
		retention: { days: over.retentionDays ?? c.retention.days },
	};
};
const DAY = { from: RECAP_DAY, to: RECAP_DAY };
const build = (
	opts: Partial<{ range: { from: string; to: string }; groupBy: "repo" | "day"; files: boolean }> = {},
	c = cfg(),
): Recap => buildRecap(db, c, { range: DAY, groupBy: "repo", files: true, now: RECAP_NOW, ...opts });
const group = (r: Recap | RecapGroup[], repo: string): RecapGroup => {
	const g = (Array.isArray(r) ? r : r.groups).find((x) => x.repo === repo);
	if (!g) throw new Error(`no group ${repo}`);
	return g;
};
const bullet = (r: Recap, id: string): RecapBullet => {
	const b = r.groups.flatMap((g) => g.bullets).find((x) => x.sessionIds.includes(id));
	if (!b) throw new Error(`no bullet for ${id}`);
	return b;
};

describe("bulletFor", () => {
	const base = { title: null, summary: null, agentName: null, files: [], repo: "billing-api" };
	it("title first", () =>
		expect(bulletFor({ ...base, title: "Add  rate\nlimiting", summary: "X. Y." })).toEqual({
			text: "Add rate limiting",
			source: "title",
		}));
	it("then the summary's first sentence", () =>
		expect(bulletFor({ ...base, summary: "Added a limiter. Also tests." })).toEqual({
			text: "Added a limiter.",
			source: "summary",
		}));
	it.each([
		['- "Fixed the retry. Then more.', "Fixed the retry."],
		["* Shipped it! Then more.", "Shipped it!"],
		["Is it done? Yes.", "Is it done?"],
		["One sentence only", "One sentence only"],
	])("summary %j → %j", (summary, text) => expect(bulletFor({ ...base, summary }).text).toBe(text));
	it("then the agent name", () =>
		expect(bulletFor({ ...base, agentName: "Feat/ingest-worker ingest" })).toEqual({
			text: "Feat/ingest-worker ingest",
			source: "agent_name",
		}));
	it("then the files, three named and the rest counted", () => {
		expect(bulletFor({ ...base, files: ["errors.go", "handlers.go", "a.go", "b.go"] })).toEqual({
			text: "errors.go, handlers.go, a.go +1",
			source: "files",
		});
		expect(bulletFor({ ...base, files: ["errors.go"] }).text).toBe("errors.go");
	});
	it("else the files it read, two named and the rest counted", () => {
		expect(bulletFor({ ...base, reads: ["backend.tf", "iam.tf", "a.tf", "b.tf"] })).toEqual({
			text: "read backend.tf, iam.tf +2",
			source: "explored",
		});
		expect(bulletFor({ ...base, reads: ["backend.tf"] }).text).toBe("read backend.tf");
	});
	it("else explored", () => expect(bulletFor(base)).toEqual({ text: "Explored billing-api", source: "explored" }));
	it("blank sources fall through", () =>
		expect(bulletFor({ ...base, title: "  ", summary: "", agentName: " " }).source).toBe("explored"));
	it.each([
		["Fixed bug in /home/u/clients/acme-private/src/pay.ts. Then more.", "Fixed bug in pay.ts."],
		["Edit C:\\Users\\x\\acme-private\\a.ts now", "Edit a.ts now"],
		["Clean ~/code/acme-private/notes.md", "Clean notes.md"],
		["Update src/recap/build.ts and tests", "Update build.ts and tests"],
		["Feat/ingest-worker ingest", "Feat/ingest-worker ingest"],
		["See https://github.com/acme/app/pull/3", "See https://github.com/acme/app/pull/3"],
	])("paths in titles and summaries become base names: %j", (raw, text) => {
		expect(bulletFor({ ...base, summary: raw }).text).toBe(text);
		expect(bulletFor({ ...base, title: raw }).text).toBe(raw.includes("Then") ? `${text} Then more.` : text);
	});
	it("cuts text over 120 characters at a word boundary with …", () => {
		const title = `${"word ".repeat(26)}end`; // 133 chars
		const { text } = bulletFor({ ...base, title });
		expect(text.length).toBeLessThanOrEqual(120);
		expect(text.endsWith("word…")).toBe(true);
		expect(bulletFor({ ...base, title: "x".repeat(120) }).text).toBe("x".repeat(120));
		expect(bulletFor({ ...base, title: "x".repeat(130) }).text).toBe(`${"x".repeat(119)}…`);
	});
});

describe("buildRecap", () => {
	it("bullet sources and file lines on the fixture day", () => {
		const r = build();
		expect(bullet(r, "titled")).toMatchObject({
			text: "Add rate limiting to the public endpoints",
			source: "title",
			files: ["errors.go", "gateway_test.go", "handlers.go"],
			moreFiles: 1,
		});
		expect(bullet(r, "summary-only")).toMatchObject({
			text: "Fixed the flaky auth integration test.",
			source: "summary",
			files: [],
		});
		expect(bullet(r, "agent-only")).toMatchObject({ source: "agent_name", files: ["pay.ts"], moreFiles: 0 });
		expect(bullet(r, "files-only")).toMatchObject({
			text: "cart.tsx, cart.test.tsx, Summary.tsx +1",
			source: "files",
			files: [],
			moreFiles: 0,
		});
		expect(bullet(r, "read-only")).toMatchObject({ text: "read README.md, plan.md +1", source: "explored", files: [] });
	});

	it("groups busiest first, ties by name; worktrees fold into the parent; no repo → cwd base name", () => {
		const r = build();
		expect(r.groups.map((g) => [g.repo, g.turns])).toEqual([
			["checkout-flow", 8],
			["api-gateway", 5],
			["notes", 4],
			["scratch", 2],
			["secret-client", 2],
		]);
		// A remote-less repo id is its root path, so it never leaves the server.
		expect(group(r, "notes").repoId).toBeNull();
		expect(group(r, "api-gateway").repoId).toBe("github.com/acme/api-gateway");
		expect(group(r, "notes").bullets.map((b) => b.sessionIds[0])).toEqual(["spanning", "read-only"]);
		expect(group(r, "scratch").repoId).toBeNull();
		expect(r.sessions).toBe(10);
		expect(r.days).toEqual([]);
	});

	it("bullets in order of each session's first turn", () => {
		const ids = group(build(), "checkout-flow").bullets.map((b) => b.sessionIds[0]);
		expect(ids).toEqual(["agent-only", "files-only", "dup-a"]);
	});

	it("merges duplicate bullet text in a group and unions the files", () => {
		const b = bullet(build(), "dup-a");
		expect(b.text).toBe("Debug the failed webhook retry");
		expect(b.sessionIds).toEqual(["dup-a", "dup-b"]);
		expect(b.files).toEqual(["webhook.ts", "retry.ts"]);
	});

	it("a base name from two directories shows once", () => {
		seedRecapSession(db, "twice", {
			repo: "api",
			title: "Touch two configs",
			turns: [at(12, 30), at(12, 40)],
			files: [
				{ path: "/home/u/code/api-gateway/a/config.ts", churn: 3, at: at(12, 31) },
				{ path: "/home/u/code/api-gateway/b/config.ts", churn: 3, at: at(12, 32) },
				{ path: "C:\\code\\api-gateway\\c\\main.ts", churn: 1, at: at(12, 33) },
			],
		});
		expect(bullet(build(), "twice").files).toEqual(["config.ts", "main.ts"]);
	});

	it("hidden repos are removed before grouping, with their files", () => {
		seedRecapSession(db, "cross", {
			repo: "api",
			title: "Patch the shared client",
			turns: [at(12, 30), at(12, 40)],
			files: [
				{ path: "/home/u/code/api-gateway/client.go", churn: 2, at: at(12, 31) },
				{ path: "/home/u/clients/secret-client/invoice_api.ts", churn: 9, at: at(12, 32) },
			],
		});
		db.prepare(
			"UPDATE file_changes SET repo_id = 'github.com/acme/secret-client' WHERE path LIKE '%invoice_api.ts'",
		).run();
		const r = build({}, cfg({ hiddenRepos: ["Secret-Client"] }));
		expect(r.groups.map((g) => g.repo)).not.toContain("secret-client");
		expect(r.hiddenRepos).toBe(1);
		expect(bullet(r, "cross").files).toEqual(["client.go"]);
		expect(JSON.stringify(r)).not.toContain("invoice");
		expect(r.sessions).toBe(10);
	});

	it("hidden by repo id, and a folded worktree of a hidden parent is hidden too", () => {
		const r = build({}, cfg({ hiddenRepos: ["/HOME/u/notes"] }));
		expect(r.groups.map((g) => g.repo)).not.toContain("notes");
		expect(JSON.stringify(r)).not.toContain("export");
		expect(r.hiddenRepos).toBe(1);
	});

	it("hiding a folded worktree by its own name hides its sessions, not the parent's", () => {
		const r = build({}, cfg({ hiddenRepos: ["fix-x"] }));
		expect(group(r, "notes").bullets.map((b) => b.sessionIds[0])).toEqual(["read-only"]);
		expect(JSON.stringify(r)).not.toContain("export");
		expect(r.hiddenRepos).toBe(1);
	});

	it("a hidden name that matches nothing is ignored", () =>
		expect(build({}, cfg({ hiddenRepos: ["nope"] })).hiddenRepos).toBe(0));

	it("by day: a spanning session appears on both days, days ascending, empty days skipped", () => {
		const r = build({ range: { from: "2026-09-25", to: RECAP_DAY }, groupBy: "day" });
		expect(r.groups).toEqual([]);
		expect(r.days.map((d) => d.date)).toEqual([RECAP_PREV, RECAP_DAY]);
		const prev = group(r.days[0].groups, "notes");
		expect(prev.bullets).toHaveLength(1);
		expect(prev.bullets[0]).toMatchObject({ sessionIds: ["spanning"], files: ["export.ts"] });
		expect(group(r.days[1].groups, "notes").bullets[0]).toMatchObject({
			sessionIds: ["spanning"],
			files: ["export.test.ts"],
		});
	});

	it("by repo over two days: a spanning session is one bullet with both days' turns and files", () => {
		const r = build({ range: { from: RECAP_PREV, to: RECAP_DAY } });
		const b = bullet(r, "spanning");
		expect(b.files).toEqual(["export.ts", "export.test.ts"]);
		expect(b.firstTurnAt).toBe(at(23, 30, -1));
		expect(group(r, "notes").turns).toBe(5);
	});

	it("activity: quarter-hour turn counts per day with work, hidden repos left out", () => {
		const q = (h: number, m: number) => h * 4 + Math.floor(m / 15);
		const r = build({}, cfg({ hiddenRepos: ["secret-client"] }));
		expect(r.activity.map((a) => a.date)).toEqual([RECAP_DAY]);
		const slots = r.activity[0].slots;
		expect(slots).toHaveLength(96);
		expect([slots[q(0, 10)], slots[q(0, 40)], slots[q(9, 0)], slots[q(9, 20)], slots[q(9, 40)]]).toEqual([
			1, 1, 1, 1, 1,
		]);
		expect(slots[q(13, 0)]).toBe(0); // the hidden secret-client session at 13:00
		expect(slots.reduce((a, b) => a + b, 0)).toBe(19);
		const two = build({ range: { from: RECAP_PREV, to: RECAP_DAY }, groupBy: "day" });
		expect(two.activity.map((a) => a.date)).toEqual([RECAP_PREV, RECAP_DAY]);
		expect(two.activity[0].slots[q(23, 30)]).toBe(1);
	});

	it("files off: no file lines", () => {
		for (const b of build({ files: false }).groups.flatMap((g) => g.bullets)) {
			expect(b.files).toEqual([]);
			expect(b.moreFiles).toBe(0);
		}
	});

	it("an empty range", () => {
		const r = build({ range: { from: "2026-01-05", to: "2026-01-05" } });
		expect(r).toMatchObject({ groups: [], days: [], sessions: 0, hiddenRepos: 0 });
	});

	it("retentionCutoff is the local date retention.days back; null when kept forever", () => {
		expect(build().retentionCutoff).toBe("2026-06-30");
		expect(build({}, cfg({ retentionDays: 0 })).retentionCutoff).toBeNull();
	});

	it("a repo whose remote is a local path has no repoId (its id is that path)", () => {
		for (const [id, remote] of [
			[`/home/u/clients/${LEAK_DIR}/app`, `/home/u/clients/${LEAK_DIR}/app`],
			[`c:/clients/${LEAK_DIR}/app`, `c:/clients/${LEAK_DIR}/app`],
		]) {
			db.prepare("INSERT INTO repos (repo_id, root_path, remote_url, name) VALUES (?, ?, ?, 'app2')").run(
				id,
				`/home/u/code/app2-${id.length}`,
				remote,
			);
			seedRecapSession(db, `local-${id.length}`, { turns: [at(12, 30), at(12, 40)], title: "Clone work" });
			db.prepare("UPDATE sessions SET repo_id = ? WHERE session_id = ?").run(id, `local-${id.length}`);
		}
		const r = build();
		expect(group(r, "app2").repoId).toBeNull();
		expect(JSON.stringify(r)).not.toContain(LEAK_DIR);
	});

	it("never contains prompt text or a directory", () => {
		for (const r of [build(), build({ groupBy: "day", range: { from: RECAP_PREV, to: RECAP_DAY } })]) {
			const json = JSON.stringify(r);
			expect(json).not.toContain(LEAK_TOKEN);
			expect(json).not.toContain(LEAK_DIR);
			expect(json).not.toContain("/home/u");
		}
	});
});

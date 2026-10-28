// Phase 7 Task 13 (P11): the size of ~/.claude/projects next to tracker.db, in Settings and doctor.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dirSize, formatBytes, projectsSize } from "../../../src/collector/storage";
import type { Db } from "../../../src/db/adapter";
import { createApp } from "../../../src/server/app";
import type { ConfigResponse } from "../../../src/server/types";
import { writeTree } from "../../helpers/claude-tree";
import { seedDb } from "../../helpers/seed";
import { type TmpHome, tmpHome } from "../../helpers/tmp-home";

let h: TmpHome;
beforeEach(() => {
	h = tmpHome();
	writeTree(h.claude, { "projects/p1/a.jsonl": "x".repeat(1000), "projects/p1/sub/b.jsonl": "y".repeat(500) });
});
afterEach(() => h.cleanup());

describe("dirSize", () => {
	it("sums every file under a folder", () => {
		expect(dirSize(`${h.claude}/projects`, 2000)).toEqual({ bytes: 1500, cut: false });
	});
	it("stops when the time budget runs out and says so", () => {
		const r = dirSize(`${h.claude}/projects`, 0);
		expect(r.cut).toBe(true);
		expect(r.bytes).toBeLessThanOrEqual(1500);
	});
	it("a missing folder is 0 bytes", () => {
		expect(dirSize(`${h.claude}/nope`, 2000)).toEqual({ bytes: 0, cut: false });
	});
	it("formats sizes, with ≥ when the walk was cut", () => {
		expect(formatBytes({ bytes: 1500, cut: false })).toBe("1.5 KB");
		expect(formatBytes({ bytes: 3 * 1024 * 1024 * 1024, cut: true })).toBe("≥ 3.0 GB");
		expect(formatBytes({ bytes: 12, cut: false })).toBe("12 B");
	});
	it("projectsSize reads Claude Code's projects folder", () => {
		expect(projectsSize({ fresh: true })).toEqual({ bytes: 1500, cut: false });
	});
});

describe("GET /api/config storage", () => {
	let db: Db;
	beforeEach(() => {
		db = seedDb();
	});
	afterEach(() => db.close());
	it("reports the projects folder size", async () => {
		const r = await createApp(db, { port: 4242, uiDir: "/x" }).request("/api/config", {
			headers: { host: "localhost:4242" },
		});
		const c = (await r.json()) as ConfigResponse;
		expect(c.storage).toEqual({ projectsBytes: 1500, projectsCut: false });
	});
});

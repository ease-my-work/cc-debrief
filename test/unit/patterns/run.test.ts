import child_process from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { repoTaskLabels } from "../../../src/coach/review";
import type { Db } from "../../../src/db/adapter";
import { listPatternRows } from "../../../src/db/queries/patterns";
import { enrichSession } from "../../../src/enrich";
import { coachErrorsLogPath } from "../../../src/paths";
import * as detect from "../../../src/patterns/detect";
import * as run from "../../../src/patterns/run";
import { detectForSession, runPatternDetection } from "../../../src/patterns/run";
import { daysAgo, PATTERN_NOW, seedPatternSession } from "../../helpers/pattern-seed";
import { seedDb } from "../../helpers/seed";
import { type TmpHome, tmpHome } from "../../helpers/tmp-home";

let h: TmpHome;
let db: Db;
beforeEach(() => {
	h = tmpHome();
	db = seedDb();
});
afterEach(() => {
	vi.restoreAllMocks();
	db.close();
	h.cleanup();
});

const NOW = PATTERN_NOW;
const log = () => (existsSync(coachErrorsLogPath()) ? readFileSync(coachErrorsLogPath(), "utf8") : "");

describe("detectForSession", () => {
	it("a third matching session in a repo creates the candidate", () => {
		seedPatternSession(db, "s1", { label: "fix trivy findings" });
		seedPatternSession(db, "s2", { label: "fix trivy findings" });
		detectForSession(db, "s2", NOW);
		expect(listPatternRows(db)).toEqual([]);
		seedPatternSession(db, "s3", { label: "fix trivy findings" });
		detectForSession(db, "s3", NOW);
		expect(listPatternRows(db).map((p) => p.sessionIds)).toEqual([["s1", "s2", "s3"]]);
	});

	it("a throwing detector is logged and never thrown", () => {
		seedPatternSession(db, "s1");
		vi.spyOn(detect, "detectPatterns").mockImplementation(() => {
			throw new Error("boom");
		});
		expect(() => detectForSession(db, "s1", NOW)).not.toThrow();
		expect(log()).toMatch(/\tpatterns s1\t/);
	});

	it("opens no network connection and spawns nothing", () => {
		const blocked = vi.fn(() => {
			throw new Error("blocked");
		});
		vi.spyOn(net.Socket.prototype, "connect").mockImplementation(blocked as never);
		vi.spyOn(http, "request").mockImplementation(blocked as never);
		vi.spyOn(https, "request").mockImplementation(blocked as never);
		vi.spyOn(globalThis, "fetch").mockImplementation(blocked as never);
		vi.spyOn(child_process, "spawn").mockImplementation(blocked as never);
		vi.spyOn(child_process, "execFile").mockImplementation(blocked as never);
		vi.spyOn(child_process, "spawnSync").mockImplementation(blocked as never);
		for (const id of ["s1", "s2", "s3"]) seedPatternSession(db, id, { label: "fix trivy findings" });
		runPatternDetection(db, { now: NOW });
		expect(blocked).not.toHaveBeenCalled();
		expect(listPatternRows(db)).toHaveLength(1);
	});
});

describe("runPatternDetection", () => {
	it("runs per repo for repos active in 30 days only, then cross-repo, then the installed checks", () => {
		seedPatternSession(db, "a1", { repo: "ra", startedAt: daysAgo(3) });
		seedPatternSession(db, "b1", { repo: "rb", startedAt: daysAgo(40) });
		seedPatternSession(db, "n1", { repo: null, startedAt: daysAgo(1) });
		const repos: (string | null)[] = [];
		vi.spyOn(detect, "detectPatterns").mockImplementation((_db, repo) => {
			repos.push(repo);
			return { created: 0, updated: 0 };
		});
		const afterwards = vi.fn();
		expect(runPatternDetection(db, { now: NOW, afterwards })).toBe(1);
		expect(repos).toEqual(["ra"]);
		expect(afterwards).toHaveBeenCalledOnce();
	});

	it("stops between repos when aborted", () => {
		seedPatternSession(db, "a1", { repo: "ra" });
		seedPatternSession(db, "b1", { repo: "rb" });
		const ctl = new AbortController();
		ctl.abort();
		expect(runPatternDetection(db, { now: NOW, signal: ctl.signal })).toBe(0);
	});
});

describe("wiring", () => {
	it("enrichSession runs detection for its session", async () => {
		seedPatternSession(db, "s1");
		const spy = vi.spyOn(run, "detectForSession").mockImplementation(() => {});
		await enrichSession(db, "s1", { ai: false });
		expect(spy).toHaveBeenCalledWith(db, "s1");
	});
});

describe("repoTaskLabels with patterns", () => {
	it("returns review labels, then the repo's skill pattern labels, without duplicates", () => {
		for (const id of ["s1", "s2", "s3"]) seedPatternSession(db, id, { label: "fix trivy findings" });
		seedPatternSession(db, "s4", { label: "add endpoint" });
		detect.detectPatterns(db, "ra", NOW);
		db.prepare(
			`INSERT INTO patterns (repo_id, label, label_norm, kind, first_seen, last_seen)
			 VALUES ('ra', 'bump base image', 'bump base image', 'repo_skill', ?, ?),
			        ('ra', 'Bash:x → Read:y', 'fp:bash:x → read:y', 'repo_skill', ?, ?),
			        ('ra', 'src/a.py', 'path:src/a.py', 'test_gap', ?, ?)`,
		).run(daysAgo(1), daysAgo(1), daysAgo(1), daysAgo(1), daysAgo(1), daysAgo(1));
		const labels = repoTaskLabels(db, "ra");
		expect(labels).toEqual(expect.arrayContaining(["fix trivy findings", "add endpoint", "bump base image"]));
		expect(labels.filter((l) => l === "fix trivy findings")).toHaveLength(1); // review and pattern label once
		expect(labels).not.toContain("Bash:x → Read:y");
		expect(labels).not.toContain("src/a.py");
		expect(labels.indexOf("bump base image")).toBeGreaterThan(labels.indexOf("add endpoint"));
	});
});

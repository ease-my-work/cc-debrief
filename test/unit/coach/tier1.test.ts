import dns from "node:dns";
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runTier1, runTier1Pending, SIGNALS, TIER1_VERSION } from "../../../src/coach/tier1";
import type { Signal } from "../../../src/coach/types";
import { setConfigValue } from "../../../src/config";
import type { Db } from "../../../src/db/adapter";
import { enrichSession } from "../../../src/enrich";
import { ingestPending } from "../../../src/ingest/ingest";
import { type FakeClaude, fakeClaude } from "../../helpers/fake-claude";
import { copyFixtureInto, FIXTURES } from "../../helpers/fixtures";
import { seedDb } from "../../helpers/seed";
import { seedCoachSession } from "../../helpers/seed-coach";
import { type TmpHome, tmpHome } from "../../helpers/tmp-home";

let h: TmpHome;
let db: Db;
beforeEach(() => {
	h = tmpHome();
	setConfigValue("retention.days", "0");
	db = seedDb();
});
afterEach(() => {
	vi.restoreAllMocks();
	db.close();
	h.cleanup();
});

const rules = (id: string) =>
	db
		.prepare("SELECT rule FROM findings WHERE session_id = ? ORDER BY rule")
		.all<{ rule: string }>(id)
		.map((r) => r.rule);
const version = (id: string) =>
	db.prepare("SELECT tier1_version AS v FROM sessions WHERE session_id = ?").get<{ v: number | null }>(id)?.v;
const errorLog = () => {
	const p = join(h.home, "coach-errors.log");
	return existsSync(p) ? readFileSync(p, "utf8") : "";
};

describe("runTier1", () => {
	it("stores one finding per firing signal and records TIER1_VERSION", () => {
		seedCoachSession(db, "s", { retry: true, churn: true });
		expect(runTier1(db, "s")).toBe(2);
		expect(rules("s")).toEqual(["context_churn", "retry_loop"]);
		expect(version("s")).toBe(TIER1_VERSION);
		// 2: costs count non-cached tokens; skill_unused and discarded_work removed (Phase 4 tuning).
		expect(TIER1_VERSION).toBe(2);
		expect(SIGNALS.map((s) => s.rule).sort()).toEqual([
			"context_churn",
			"long_session_no_compaction",
			"mcp_bypassed",
			"permission_friction",
			"retry_loop",
		]);
	});

	it("logs a throwing signal and still stores the others", () => {
		seedCoachSession(db, "s", { retry: true, churn: true });
		const boom: Signal = {
			rule: "boom",
			detect() {
				throw new Error("kaput");
			},
		};
		expect(runTier1(db, "s", { signals: [boom, ...SIGNALS] })).toBe(2);
		expect(rules("s")).toEqual(["context_churn", "retry_loop"]);
		expect(errorLog()).toMatch(/\tboom s\tkaput\n$/);
	});

	it("is idempotent and keeps feedback on rerun", () => {
		seedCoachSession(db, "s", { retry: true, churn: true });
		runTier1(db, "s");
		db.prepare("UPDATE findings SET feedback = 'helpful' WHERE rule = 'retry_loop'").run();
		const before = db.prepare("SELECT id, created_at, message FROM findings ORDER BY id").all();
		runTier1(db, "s");
		expect(db.prepare("SELECT id, created_at, message FROM findings ORDER BY id").all()).toEqual(before);
		expect(db.prepare("SELECT feedback FROM findings WHERE rule = 'retry_loop'").get()).toEqual({
			feedback: "helpful",
		});
	});

	it("makes no network call", () => {
		const calls: string[] = [];
		const record = (what: string) => () => {
			calls.push(what);
			throw new Error(`blocked ${what}`);
		};
		vi.spyOn(net.Socket.prototype, "connect").mockImplementation(record("net") as never);
		vi.spyOn(http, "request").mockImplementation(record("http") as never);
		vi.spyOn(https, "request").mockImplementation(record("https") as never);
		vi.spyOn(dns, "lookup").mockImplementation(record("dns") as never);
		vi.spyOn(globalThis, "fetch").mockImplementation(record("fetch") as never);
		seedCoachSession(db, "s", { retry: true, churn: true });
		runTier1(db, "s");
		expect(calls).toEqual([]);
	});

	it("runs on a real fixture session and stores none of the removed rules", () => {
		copyFixtureInto(h.claude, join(FIXTURES, "transcripts", "cli", "windows-scenario-s"));
		const [id] = ingestPending(db).sessions;
		runTier1(db, id);
		expect(rules(id).filter((r) => r === "skill_unused" || r === "discarded_work")).toEqual([]);
		expect(version(id)).toBe(TIER1_VERSION);
	});
});

describe("runTier1Pending", () => {
	const now = Date.now();
	const ago = (days: number) => new Date(now - days * 86_400_000).toISOString();

	it("checks sessions in range with no or an older tier1_version, newest first", () => {
		seedCoachSession(db, "new", { startedAt: ago(1), retry: true });
		seedCoachSession(db, "old-version", { startedAt: ago(2), retry: true, tier1Version: 0 });
		seedCoachSession(db, "current", { startedAt: ago(3), retry: true, tier1Version: TIER1_VERSION });
		seedCoachSession(db, "too-old", { startedAt: ago(40), retry: true });
		const progress: [number, number][] = [];
		const n = runTier1Pending(db, { since: new Date(ago(30)), onProgress: (d, t) => progress.push([d, t]) });
		expect(n).toBe(2);
		expect(rules("new")).toEqual(["retry_loop"]);
		expect(rules("old-version")).toEqual(["retry_loop"]);
		expect(rules("current")).toEqual([]);
		expect(rules("too-old")).toEqual([]);
		expect(version("too-old")).toBeNull();
		expect(progress).toEqual([
			[0, 2],
			[1, 2],
			[2, 2],
		]);
	});

	it("stops at the limit", () => {
		for (const id of ["a", "b", "c"]) seedCoachSession(db, id, { startedAt: ago(1) });
		expect(runTier1Pending(db, { since: new Date(ago(30)), limit: 2 })).toBe(2);
	});
});

describe("enrichSession runs Tier 1", () => {
	let fake: FakeClaude;
	let restore: () => void;
	beforeEach(() => {
		fake = fakeClaude(h.home);
		restore = fake.install();
	});
	afterEach(() => restore());

	it("stores findings with summaries off and spawns no claude", async () => {
		setConfigValue("ai.summaries.enabled", "false");
		seedCoachSession(db, "s", { retry: true, churn: true });
		await enrichSession(db, "s", { ai: true });
		expect(rules("s")).toEqual(["context_churn", "retry_loop"]);
		expect(version("s")).toBe(TIER1_VERSION);
		expect(fake.invocations()).toEqual([]);
	});

	it("stores findings with ai off", async () => {
		seedCoachSession(db, "s", { retry: true });
		await enrichSession(db, "s", { ai: false });
		expect(rules("s")).toEqual(["retry_loop"]);
	});
});

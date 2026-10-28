import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setConfigValue } from "../../src/config";
import type { Db } from "../../src/db/adapter";
import { getPattern, setPatternStatus, upsertPattern } from "../../src/db/queries/patterns";
import { checkInstalledPatterns } from "../../src/patterns/adoption";
import { detectPatterns } from "../../src/patterns/detect";
import { createApp } from "../../src/server/app";
import type {
	DraftFile,
	DraftResponse,
	ImprovementsResponse,
	InstallResponse,
	InventoryResponse,
	PatternsResponse,
	RepoDetail,
} from "../../src/server/types";
import { type FakeClaude, fakeClaude, successResult } from "../helpers/fake-claude";
import { daysAgo, PATTERN_NOW, seedPatternSession, TRIVY_CALLS } from "../helpers/pattern-seed";
import { seedDb } from "../helpers/seed";
import { type TmpHome, tmpHome } from "../helpers/tmp-home";

const HOST = { host: "127.0.0.1:4242" };
const JSON_HEADERS = { ...HOST, "content-type": "application/json" };
const DRAFT = {
	name: "trivy-fix",
	description: "Fix trivy findings.",
	body: "## Steps\n1. Run trivy.\n",
	rule_text: null,
	target_file: null,
};

let h: TmpHome;
let db: Db;
let fake: FakeClaude;
let restore: () => void;
let root: string;
beforeEach(() => {
	h = tmpHome();
	db = seedDb();
	fake = fakeClaude(h.home);
	restore = fake.install();
	fake.scenario({ stdout: successResult(DRAFT) });
	root = mkdtempSync(join(tmpdir(), "ccd-repo-"));
	db.prepare("INSERT INTO repos (repo_id, root_path, name) VALUES ('ra', ?, 'app')").run(root);
	setConfigValue("ai.drafts.enabled", "true");
	// Estimates price on the most-used model (no pin: the fake answers as Haiku).
	// Routes read the real clock: pin it to the fixture's NOW so daysAgo() ages stay put.
	vi.useFakeTimers({ now: PATTERN_NOW, toFake: ["Date"] });
});
afterEach(() => {
	vi.useRealTimers();
	restore();
	db.close();
	rmSync(root, { recursive: true, force: true });
	h.cleanup();
});

const app = () => createApp(db, { port: 4242, uiDir: "/x" });
const get = async <T>(path: string) => {
	const r = await app().request(path, { headers: HOST });
	return { status: r.status, body: (await r.json()) as T };
};
const send = async (
	method: "POST" | "PUT",
	path: string,
	body: unknown = {},
	headers: Record<string, string> = JSON_HEADERS,
) => {
	const r = await app().request(path, { method, headers, body: JSON.stringify(body) });
	return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};
const code = (b: Record<string, unknown>) => (b.error as { code: string }).code;

/** A repo_skill candidate from 3 labelled sessions over the cost floor. */
function candidate(label = "fix trivy findings", prefix = "s", calls = TRIVY_CALLS): number {
	for (const i of [1, 2, 3]) seedPatternSession(db, `${prefix}${i}`, { label, calls, startedAt: daysAgo(4 - i) });
	db.prepare("UPDATE usage SET model = 'claude-sonnet-4-5'").run();
	detectPatterns(db, "ra");
	return (db.prepare("SELECT id FROM patterns WHERE label = ?").get(label) as { id: number }).id;
}
function rule(): number {
	return upsertPattern(db, {
		repoId: "ra",
		label: "use httpx not requests",
		labelNorm: "httpx request",
		kind: "claude_md_rule",
		sessionIds: [],
		tokensTotal: 60_000,
		fingerprint: null,
		firstSeen: daysAgo(3),
		lastSeen: daysAgo(1),
		meta: { correctionCount: 3, corrections: ["use httpx not requests"] },
	}).id;
}

describe("GET /api/patterns", () => {
	it("lists PatternRow items with a draft estimate, filtered by repo and status", async () => {
		const id = candidate();
		const r = await get<PatternsResponse>("/api/patterns?repo=ra");
		expect(r.status).toBe(200);
		expect(r.body.patterns).toEqual([
			expect.objectContaining({
				id,
				kind: "repo_skill",
				label: "fix trivy findings",
				sessionCount: 3,
				status: "candidate",
			}),
		]);
		expect(r.body.patterns[0].estDraftUsd).toBeGreaterThan(0);
		expect((await get<PatternsResponse>("/api/patterns?status=installed")).body.patterns).toEqual([]);
	});
});

describe("drafts", () => {
	it("POST draft: the draft path, actual cost and estimate", async () => {
		const id = candidate();
		const r = await send("POST", `/api/patterns/${id}/draft`, {});
		expect(r.status).toBe(200);
		const body = r.body as unknown as DraftResponse;
		expect(body.draftPath.endsWith(join("app", "trivy-fix", "SKILL.md"))).toBe(true);
		expect(body.costUsd).toBeGreaterThan(0);
		expect(body.estUsd).toBeGreaterThan(0);
		expect(getPattern(db, id)?.status).toBe("drafted");
	});

	it("drafts off: 409 drafts_disabled and no spawn; the free rule draft still works", async () => {
		setConfigValue("ai.drafts.enabled", "false");
		const id = candidate();
		const r = await send("POST", `/api/patterns/${id}/draft`, {});
		expect([r.status, code(r.body)]).toEqual([409, "drafts_disabled"]);
		expect(fake.invocations()).toHaveLength(0);
		const ruleId = rule();
		const d = await send("POST", `/api/patterns/${ruleId}/draft-rule`);
		expect(d.status).toBe(200);
		expect(readFileSync(String(d.body.draftPath), "utf8")).toBe("Use httpx, not requests.\n");
	});

	it("claude fails: 502 draft_failed with the reason", async () => {
		const id = candidate();
		fake.scenario({ exitCode: 1, stderr: "boom" });
		const r = await send("POST", `/api/patterns/${id}/draft`, {});
		expect([r.status, code(r.body)]).toEqual([502, "draft_failed"]);
		const rows = (await get<PatternsResponse>("/api/patterns")).body.patterns;
		expect(rows[0].error).toMatch(/exit 1/);
	});

	it("draft-rule on a skill pattern: 409 invalid_draft; unknown pattern: 404", async () => {
		const id = candidate();
		expect((await send("POST", `/api/patterns/${id}/draft-rule`)).status).toBe(409);
		expect((await send("POST", "/api/patterns/999/draft", {})).status).toBe(404);
		expect((await send("POST", "/api/patterns/abc/draft", {})).status).toBe(404);
	});

	it("GET and PUT the draft; PUT with bad front matter: 422", async () => {
		const id = candidate();
		expect((await get(`/api/patterns/${id}/draft`)).status).toBe(404);
		await send("POST", `/api/patterns/${id}/draft`, {});
		const file = (await get<DraftFile>(`/api/patterns/${id}/draft`)).body;
		expect(file.content).toContain("name: trivy-fix");
		const ok = await send("PUT", `/api/patterns/${id}/draft`, {
			content: "---\nname: trivy-fix\ndescription: Edited.\n---\nBody\n",
		});
		expect(ok).toEqual({ status: 200, body: { ok: true } });
		const bad = await send("PUT", `/api/patterns/${id}/draft`, {
			content: "---\nname: Bad Name\ndescription: x\n---\n",
		});
		expect([bad.status, code(bad.body)]).toEqual([422, "invalid_draft"]);
	});
});

describe("install", () => {
	it("200 with the written paths and the inventory row", async () => {
		const id = candidate();
		await send("POST", `/api/patterns/${id}/draft`, {});
		const r = await send("POST", `/api/patterns/${id}/install`);
		expect(r.status).toBe(200);
		const body = r.body as unknown as InstallResponse;
		expect(body.written).toEqual([join(root, ".claude", "skills", "trivy-fix", "SKILL.md")]);
		expect(body.inventoryId).toEqual(expect.any(Number));
	});

	it("refusals are 409 with the reason", async () => {
		const id = candidate();
		expect(code((await send("POST", `/api/patterns/${id}/install`)).body)).toBe("invalid_draft");
		await send("POST", `/api/patterns/${id}/draft`, {});
		mkdirSync(join(root, ".claude", "skills", "trivy-fix"), { recursive: true });
		const r = await send("POST", `/api/patterns/${id}/install`);
		expect([r.status, code(r.body)]).toEqual([409, "target_exists"]);
		rmSync(root, { recursive: true, force: true });
		expect(code((await send("POST", `/api/patterns/${id}/install`)).body)).toBe("repo_missing");
	});

	it("write routes are rejected cross-origin", async () => {
		const id = candidate();
		const evil = { ...JSON_HEADERS, origin: "https://evil.example" };
		for (const [m, p] of [
			["POST", `/api/patterns/${id}/draft`],
			["POST", `/api/patterns/${id}/draft-rule`],
			["PUT", `/api/patterns/${id}/draft`],
			["POST", `/api/patterns/${id}/install`],
			["POST", `/api/patterns/${id}/dismiss`],
		] as const)
			expect((await send(m, p, {}, evil)).status, p).toBe(403);
		expect(fake.invocations()).toHaveLength(0);
	});
});

describe("dismiss", () => {
	it("dismisses the pattern and removes its digest item", async () => {
		const id = candidate();
		expect((await get<ImprovementsResponse>("/api/improvements?range=7d")).body.items).toHaveLength(1);
		expect((await send("POST", `/api/patterns/${id}/dismiss`)).body).toEqual({ ok: true });
		expect(getPattern(db, id)?.status).toBe("dismissed");
		expect((await get<ImprovementsResponse>("/api/improvements?range=7d")).body.items).toEqual([]);
	});
});

describe("views", () => {
	it("repo detail suggestions: candidates by tokens, then drafted, installed, test gaps; no dismissed", async () => {
		const a = candidate("fix trivy findings", "a");
		const b = candidate("add alembic column", "b", []);
		db.prepare("UPDATE patterns SET tokens_total = 200000 WHERE id = ?").run(b);
		setPatternStatus(db, a, "drafted");
		upsertPattern(db, {
			repoId: "ra",
			label: "src/a.py",
			labelNorm: "path:src/a.py",
			kind: "test_gap",
			sessionIds: [],
			tokensTotal: 999_999,
			fingerprint: null,
			firstSeen: daysAgo(2),
			lastSeen: daysAgo(1),
		});
		const dismissed = rule();
		setPatternStatus(db, dismissed, "dismissed");
		const s = (await get<RepoDetail>(`/api/repos/${encodeURIComponent("ra")}?range=30d`)).body.suggestions;
		expect(s.map((p) => [p.label, p.status])).toEqual([
			["add alembic column", "candidate"],
			["fix trivy findings", "drafted"],
			["src/a.py", "candidate"],
		]);
	});

	it("proposed skills on GET /api/inventory?kind=skill, with adoption for an installed one", async () => {
		const id = candidate();
		await send("POST", `/api/patterns/${id}/draft`, {});
		await send("POST", `/api/patterns/${id}/install`);
		const proposed = (await get<InventoryResponse>("/api/inventory?kind=skill")).body.proposed;
		expect(proposed).toEqual([
			expect.objectContaining({
				patternId: id,
				name: "trivy-fix",
				description: "Fix trivy findings.",
				repo: { id: "ra", name: "app" },
				status: "installed",
				installedDays: 0,
				invoked: 0,
				action: null,
				removed: false,
			}),
		]);
		expect(proposed?.[0].medianTokens).toEqual({ before: 30_000, after: null, pct: null });
		expect((await get<InventoryResponse>("/api/inventory?kind=mcp")).body.proposed).toBeUndefined();
	});

	it("a not-triggering skill's action is widen with an estimate", async () => {
		const id = candidate();
		await send("POST", `/api/patterns/${id}/draft`, {});
		await send("POST", `/api/patterns/${id}/install`);
		// The view counts installed days from the real clock.
		const realDaysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
		db.prepare("UPDATE patterns SET installed_at = ? WHERE id = ?").run(realDaysAgo(20), id);
		db.prepare("UPDATE sessions SET started_at = ? WHERE session_id = 's3'").run(realDaysAgo(1));
		checkInstalledPatterns(db);
		const [p] = (await get<InventoryResponse>("/api/inventory?kind=skill")).body.proposed ?? [];
		expect(p).toMatchObject({ action: "widen", installedDays: 20 });
		expect(p.estUsd).toBeGreaterThan(0);
	});

	it("a digest repeat_pattern item for a skill candidate carries the draft action", async () => {
		const id = candidate();
		const [item] = (await get<ImprovementsResponse>("/api/improvements?range=7d")).body.items;
		expect(item).toMatchObject({ rule: "repeat_pattern", action: { kind: "draft", patternId: id } });
		expect(item.action?.estUsd).toBeGreaterThan(0);
	});

	it("two repeated tasks in one repo are two digest items", async () => {
		candidate("fix trivy findings", "a");
		candidate("add alembic column", "b", []);
		expect((await get<ImprovementsResponse>("/api/improvements?range=7d")).body.items).toHaveLength(2);
	});
});

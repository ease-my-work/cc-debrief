import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Config, ConfigSchema } from "../../../src/config";
import type { Db } from "../../../src/db/adapter";
import { getPattern, setPatternStatus, upsertPattern } from "../../../src/db/queries/patterns";
import { detectPatterns } from "../../../src/patterns/detect";
import { draftDeterministic, draftPattern } from "../../../src/patterns/draft";
import { installDraft, UnsafeTargetError } from "../../../src/patterns/install";
import { type FakeClaude, fakeClaude, successResult } from "../../helpers/fake-claude";
import { daysAgo, PATTERN_NOW, seedPatternSession, TRIVY_CALLS } from "../../helpers/pattern-seed";
import { seedDb } from "../../helpers/seed";
import { type TmpHome, tmpHome } from "../../helpers/tmp-home";

let h: TmpHome;
let db: Db;
let fake: FakeClaude;
let restore: () => void;
let root: string;
let outside: string;
beforeEach(() => {
	h = tmpHome();
	db = seedDb();
	fake = fakeClaude(h.home);
	restore = fake.install();
	root = mkdtempSync(join(tmpdir(), "ccd-repo-"));
	outside = mkdtempSync(join(tmpdir(), "ccd-out-"));
	db.prepare("INSERT INTO repos (repo_id, root_path, name) VALUES ('ra', ?, 'app')").run(root);
});
afterEach(() => {
	restore();
	db.close();
	rmSync(root, { recursive: true, force: true });
	rmSync(outside, { recursive: true, force: true });
	h.cleanup();
});

const cfg = (): Config => {
	const c = ConfigSchema.parse({});
	return { ...c, ai: { ...c.ai, drafts: { enabled: true } } };
};
const DRAFT = {
	name: "trivy-fix",
	description: "Fix trivy findings.",
	body: "## Steps\n1. Run trivy.\n",
	rule_text: null,
	target_file: null,
};

function pattern(
	kind: "repo_skill" | "user_skill" | "claude_md_rule" | "claude_md_pointer" | "test_gap" = "repo_skill",
	label = "fix trivy findings",
): number {
	for (const id of ["s1", "s2", "s3"])
		if (!db.prepare("SELECT 1 AS x FROM sessions WHERE session_id = ?").get(id))
			seedPatternSession(db, id, { calls: TRIVY_CALLS });
	return upsertPattern(db, {
		repoId: kind === "user_skill" ? null : "ra",
		label,
		labelNorm: label.toLowerCase(),
		kind,
		sessionIds: ["s1", "s2", "s3"],
		tokensTotal: 90_000,
		fingerprint: null,
		firstSeen: daysAgo(5),
		lastSeen: daysAgo(1),
		meta: kind === "claude_md_pointer" ? { readFiles: ["docs/arch.md"] } : {},
	}).id;
}
async function drafted(
	kind: "repo_skill" | "user_skill" = "repo_skill",
	over: Partial<typeof DRAFT> = {},
): Promise<number> {
	const id = pattern(kind);
	fake.scenario({ stdout: successResult({ ...DRAFT, ...over }) });
	await draftPattern(db, id, cfg());
	return id;
}
const refusal = (fn: () => unknown): string => {
	try {
		fn();
	} catch (e) {
		if (e instanceof UnsafeTargetError) return e.code;
		throw e;
	}
	throw new Error("expected a refusal");
};
function treeHash(dir: string): string {
	const hash = createHash("sha256");
	const walk = (d: string) => {
		for (const name of readdirSync(d).sort()) {
			const p = join(d, name);
			hash.update(p);
			if (statSync(p).isDirectory()) walk(p);
			else hash.update(readFileSync(p));
		}
	};
	if (existsSync(dir)) walk(dir);
	return hash.digest("hex");
}

describe("installDraft", () => {
	it("repo skill: the draft is written, the inventory row linked, the pattern installed", async () => {
		const id = await drafted();
		const r = installDraft(db, id, PATTERN_NOW);
		const file = join(root, ".claude", "skills", "trivy-fix", "SKILL.md");
		expect(r.written).toEqual([file]);
		expect(readFileSync(file, "utf8")).toBe(readFileSync(getPattern(db, id)?.draftPath as string, "utf8"));
		expect(r.inventoryId).toEqual(expect.any(Number));
		expect(getPattern(db, id)).toMatchObject({
			status: "installed",
			inventoryId: r.inventoryId,
			installedAt: PATTERN_NOW.toISOString(),
		});
		expect(db.prepare("SELECT name, scope, repo_id FROM inventory WHERE id = ?").get(r.inventoryId)).toEqual({
			name: "trivy-fix",
			scope: "repo",
			repo_id: "ra",
		});
	});

	it("an existing skill directory: target_exists, nothing written", async () => {
		const id = await drafted();
		mkdirSync(join(root, ".claude", "skills", "trivy-fix"), { recursive: true });
		expect(refusal(() => installDraft(db, id))).toBe("target_exists");
		expect(existsSync(join(root, ".claude", "skills", "trivy-fix", "SKILL.md"))).toBe(false);
		expect(getPattern(db, id)?.status).toBe("drafted");
	});

	it("the repo root is gone: repo_missing", async () => {
		const id = await drafted();
		rmSync(root, { recursive: true, force: true });
		expect(refusal(() => installDraft(db, id))).toBe("repo_missing");
	});

	it("invalid front matter in the draft: invalid_draft", async () => {
		const id = await drafted();
		writeFileSync(getPattern(db, id)?.draftPath as string, "---\nname: Bad Name\ndescription: x\n---\n");
		expect(refusal(() => installDraft(db, id))).toBe("invalid_draft");
	});

	it("no draft yet: invalid_draft", () => {
		expect(refusal(() => installDraft(db, pattern()))).toBe("invalid_draft");
	});

	it("a target_file of ../../evil.md is treated as CLAUDE.md, never outside", () => {
		const id = pattern("claude_md_rule", "use httpx not requests");
		const { draftPath } = draftDeterministic(db, id);
		const metaPath = join(draftPath, "..", "draft.json");
		writeFileSync(
			metaPath,
			JSON.stringify({ ...JSON.parse(readFileSync(metaPath, "utf8")), targetFile: "../../evil.md" }),
		);
		expect(installDraft(db, id).written).toEqual([join(root, "CLAUDE.md")]);
		expect(existsSync(join(root, "..", "..", "evil.md"))).toBe(false);
	});

	it("a rewritten rule whose model name differs from the label installs to its .claude/rules file", async () => {
		const id = pattern("claude_md_rule", "use httpx not requests");
		fake.scenario({
			stdout: successResult({
				...DRAFT,
				name: "prefer-httpx",
				rule_text: "Use httpx, not requests.",
				target_file: ".claude/rules/prefer-httpx.md",
			}),
		});
		await draftPattern(db, id, cfg(), { mode: "rewrite_rule" });
		const file = join(root, ".claude", "rules", "prefer-httpx.md");
		expect(installDraft(db, id).written).toEqual([file]);
		expect(readFileSync(file, "utf8")).toBe("Use httpx, not requests.\n");
		expect(existsSync(join(root, "CLAUDE.md"))).toBe(false);
	});

	it(".claude/skills as a symlink (a junction on Windows) to outside the repo: unsafe_target", async () => {
		const id = await drafted();
		mkdirSync(join(root, ".claude"));
		symlinkSync(outside, join(root, ".claude", "skills"), process.platform === "win32" ? "junction" : "dir");
		expect(refusal(() => installDraft(db, id))).toBe("unsafe_target");
		expect(readdirSync(outside)).toEqual([]);
	});

	it.skipIf(process.platform === "win32")("CLAUDE.md as a symlink: unsafe_target", () => {
		const id = pattern("claude_md_rule", "use httpx not requests");
		draftDeterministic(db, id);
		writeFileSync(join(outside, "CLAUDE.md"), "theirs\n");
		symlinkSync(join(outside, "CLAUDE.md"), join(root, "CLAUDE.md"));
		expect(refusal(() => installDraft(db, id))).toBe("unsafe_target");
		expect(readFileSync(join(outside, "CLAUDE.md"), "utf8")).toBe("theirs\n");
	});

	it("a rule into an existing CLAUDE.md without a trailing newline: original bytes, blank line, rule, newline", () => {
		writeFileSync(join(root, "CLAUDE.md"), "# Repo\nUse tabs.");
		const id = pattern("claude_md_rule", "use httpx not requests");
		draftDeterministic(db, id);
		expect(installDraft(db, id)).toEqual({ written: [join(root, "CLAUDE.md")], inventoryId: null });
		expect(readFileSync(join(root, "CLAUDE.md"), "utf8")).toBe("# Repo\nUse tabs.\n\nUse httpx, not requests.\n");
		expect(getPattern(db, id)?.status).toBe("installed");
	});

	it("a rule with no CLAUDE.md creates it", () => {
		const id = pattern("claude_md_rule", "use httpx not requests");
		draftDeterministic(db, id);
		installDraft(db, id);
		expect(readFileSync(join(root, "CLAUDE.md"), "utf8")).toBe("Use httpx, not requests.\n");
	});

	it("a user skill goes under CLAUDE_CONFIG_DIR/skills, never into a repo", async () => {
		const id = await drafted("user_skill");
		const r = installDraft(db, id);
		expect(r.written).toEqual([join(h.claude, "skills", "trivy-fix", "SKILL.md")]);
		expect(existsSync(join(root, ".claude"))).toBe(false);
		expect(db.prepare("SELECT scope, repo_id FROM inventory WHERE id = ?").get(r.inventoryId)).toEqual({
			scope: "user",
			repo_id: null,
		});
	});

	it("a widen install changes only the description; the body bytes stay", async () => {
		const id = await drafted();
		installDraft(db, id);
		const file = join(root, ".claude", "skills", "trivy-fix", "SKILL.md");
		writeFileSync(file, `${readFileSync(file, "utf8")}\nLocal note  kept\r\n`);
		const body = (s: string) => s.slice(s.indexOf("## Steps"));
		const before = readFileSync(file, "utf8");
		fake.scenario({ stdout: successResult({ ...DRAFT, description: "Use for trivy, CVE or scanner findings." }) });
		await draftPattern(db, id, cfg(), { mode: "widen" });
		const r = installDraft(db, id);
		const after = readFileSync(file, "utf8");
		expect(r.written).toEqual([file]);
		expect(body(after)).toBe(body(before));
		expect(after).toContain("Use for trivy, CVE or scanner findings.");
		expect(getPattern(db, id)?.status).toBe("installed");
	});

	it("nothing outside drafts is written by detection or drafting (no install call)", async () => {
		for (const id of ["a1", "a2", "a3"]) seedPatternSession(db, id, { label: "bump base image", calls: TRIVY_CALLS });
		const repoBefore = treeHash(root);
		const claudeBefore = treeHash(h.claude);
		detectPatterns(db, "ra", PATTERN_NOW);
		const [p] = db.prepare("SELECT id FROM patterns").all<{ id: number }>();
		fake.scenario({ stdout: successResult(DRAFT) });
		await draftPattern(db, p.id, cfg());
		setPatternStatus(db, p.id, "drafted");
		expect(treeHash(root)).toBe(repoBefore);
		expect(treeHash(h.claude)).toBe(claudeBefore);
	});

	it("a test gap is not installable", () => {
		expect(refusal(() => installDraft(db, pattern("test_gap", "src/a.py")))).toBe("invalid_draft");
	});
});

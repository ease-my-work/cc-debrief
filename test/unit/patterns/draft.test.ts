import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { frontMatter } from "../../../src/collector/inventory";
import { type Config, ConfigSchema } from "../../../src/config";
import type { Db } from "../../../src/db/adapter";
import { getPattern, setPatternStatus, upsertPattern } from "../../../src/db/queries/patterns";
import { draftsDir } from "../../../src/paths";
import {
	DraftsDisabledError,
	draftDeterministic,
	draftMeta,
	draftPattern,
	InvalidDraftError,
	readDraft,
	ruleLine,
	safeTargetFile,
	saveDraft,
	slugifySkillName,
	storedTargetFile,
	withDescription,
} from "../../../src/patterns/draft";
import { type FakeClaude, fakeClaude, successResult } from "../../helpers/fake-claude";
import { daysAgo, seedPatternSession, TRIVY_CALLS } from "../../helpers/pattern-seed";
import { seedDb } from "../../helpers/seed";
import { type TmpHome, tmpHome } from "../../helpers/tmp-home";

let h: TmpHome;
let db: Db;
let fake: FakeClaude;
let restore: () => void;
beforeEach(() => {
	h = tmpHome();
	db = seedDb();
	fake = fakeClaude(h.home);
	restore = fake.install();
});
afterEach(() => {
	restore();
	db.close();
	h.cleanup();
});

const cfg = (drafts = true): Config => {
	const c = ConfigSchema.parse({});
	return { ...c, ai: { ...c.ai, drafts: { enabled: drafts } } };
};
const DRAFT = {
	name: "Trivy Fix!!",
	description: "Fix trivy image findings: bump the base image and rebuild.",
	body: "## Steps\n1. Run `trivy image app`.\n2. Bump the base image in the Dockerfile.\n",
	rule_text: null,
	target_file: null,
};

function pattern(
	over: {
		kind?: "repo_skill" | "user_skill" | "claude_md_rule" | "claude_md_pointer" | "test_gap";
		label?: string;
		meta?: object;
	} = {},
): number {
	for (const id of ["s1", "s2", "s3"])
		if (!db.prepare("SELECT 1 AS x FROM sessions WHERE session_id = ?").get(id))
			seedPatternSession(db, id, { calls: TRIVY_CALLS, label: "fix trivy findings" });
	return upsertPattern(db, {
		repoId: over.kind === "user_skill" ? null : "ra",
		label: over.label ?? "fix trivy findings",
		labelNorm: (over.label ?? "fix trivy findings").toLowerCase(),
		kind: over.kind ?? "repo_skill",
		sessionIds: ["s1", "s2", "s3"],
		tokensTotal: 90_000,
		fingerprint: null,
		firstSeen: daysAgo(5),
		lastSeen: daysAgo(1),
		meta: over.meta ?? {},
	}).id;
}
const mode = (path: string) => statSync(path).mode & 0o777;

describe("slugs and targets", () => {
	it("slugifies model names, falling back to the label", () => {
		expect(slugifySkillName("My Skill!!", "x")).toBe("my-skill");
		expect(slugifySkillName("!!!", "Fix Trivy findings")).toBe("fix-trivy-findings");
		expect(slugifySkillName("", "")).toBe("skill");
		expect(slugifySkillName("a".repeat(100), "x")).toHaveLength(64);
	});

	it("target_file is CLAUDE.md or .claude/rules/<slug>.md, never anything else", () => {
		expect(safeTargetFile(".claude/rules/httpx.md", "httpx")).toBe(".claude/rules/httpx.md");
		expect(safeTargetFile("../../evil.md", "httpx")).toBe("CLAUDE.md");
		expect(safeTargetFile(".claude/rules/other.md", "httpx")).toBe("CLAUDE.md");
		expect(safeTargetFile(null, "x")).toBe("CLAUDE.md");
		expect(storedTargetFile(".claude/rules/prefer-httpx.md")).toBe(".claude/rules/prefer-httpx.md");
		expect(storedTargetFile(".claude\\rules\\prefer-httpx.md")).toBe(".claude/rules/prefer-httpx.md");
		expect(storedTargetFile(".claude/rules/../evil.md")).toBe("CLAUDE.md");
		expect(storedTargetFile(".claude/rules/Bad_Name.md")).toBe("CLAUDE.md");
		expect(storedTargetFile(`.claude/rules/${"a".repeat(65)}.md`)).toBe("CLAUDE.md");
		expect(storedTargetFile(undefined)).toBe("CLAUDE.md");
	});

	it("ruleLine makes one imperative line", () => {
		expect(ruleLine("use httpx not requests")).toBe("Use httpx, not requests.");
		expect(ruleLine("never commit .env files;")).toBe("Never commit .env files.");
	});
});

describe("draftPattern", () => {
	it("writes SKILL.md and draft.json under draftsDir with private modes, and marks the pattern drafted", async () => {
		const id = pattern();
		fake.scenario({ stdout: successResult(DRAFT) });
		const r = await draftPattern(db, id, cfg());
		expect(r.draftPath).toBe(join(draftsDir(), "ra", "trivy-fix", "SKILL.md"));
		expect(r.costUsd).toBeGreaterThan(0);
		const text = readFileSync(r.draftPath, "utf8");
		expect(text).toMatch(
			/^---\nname: trivy-fix\ndescription: 'Fix trivy image findings: bump the base image and rebuild\.'\n---\n## Steps/,
		);
		expect(draftMeta(db, id)).toMatchObject({ patternId: id, sessions: ["s3", "s2", "s1"], mode: "create" });
		if (process.platform !== "win32") {
			expect(mode(r.draftPath)).toBe(0o600);
			expect(mode(join(draftsDir(), "ra", "trivy-fix"))).toBe(0o700);
		}
		expect(getPattern(db, id)).toMatchObject({ status: "drafted", draftPath: r.draftPath });
		expect(db.prepare("SELECT feature FROM self_usage").all()).toEqual([{ feature: "draft" }]);
		const [inv] = fake.invocations();
		expect(inv.stdin.split("\n")[0]).toBe("[cc-debrief:draft]");
		expect(inv.argv).not.toContain("--resume");
	});

	it("drafts off: DraftsDisabledError and no spawn", async () => {
		const id = pattern();
		await expect(draftPattern(db, id, cfg(false))).rejects.toBeInstanceOf(DraftsDisabledError);
		expect(fake.invocations()).toHaveLength(0);
	});

	it("an empty model name becomes the label slug; a taken directory gets -2", async () => {
		const a = pattern();
		const b = pattern({ label: "fix trivy findings again" });
		fake.scenario({ stdout: successResult({ ...DRAFT, name: "***" }) });
		expect((await draftPattern(db, a, cfg())).draftPath).toBe(
			join(draftsDir(), "ra", "fix-trivy-findings", "SKILL.md"),
		);
		fake.scenario({ stdout: successResult({ ...DRAFT, name: "fix trivy findings" }) });
		expect((await draftPattern(db, b, cfg())).draftPath).toBe(
			join(draftsDir(), "ra", "fix-trivy-findings-2", "SKILL.md"),
		);
		// the same pattern again reuses its own directory
		expect((await draftPattern(db, b, cfg())).draftPath).toBe(
			join(draftsDir(), "ra", "fix-trivy-findings-2", "SKILL.md"),
		);
	});

	it("a user skill drafts under drafts/user", async () => {
		const id = pattern({ kind: "user_skill" });
		fake.scenario({ stdout: successResult(DRAFT) });
		expect((await draftPattern(db, id, cfg())).draftPath).toBe(join(draftsDir(), "user", "trivy-fix", "SKILL.md"));
	});

	it("claude fails: status stays candidate, the error is on the pattern, no retry", async () => {
		const id = pattern();
		fake.scenario({ exitCode: 1, stderr: "boom" });
		await expect(draftPattern(db, id, cfg())).rejects.toThrow(/exit 1/);
		expect(getPattern(db, id)).toMatchObject({ status: "candidate", draftPath: null });
		expect(getPattern(db, id)?.meta.error).toMatch(/exit 1/);
		expect(fake.invocations()).toHaveLength(1);
		fake.scenario({ stdout: successResult(DRAFT) });
		await draftPattern(db, id, cfg());
		expect(getPattern(db, id)?.meta.error).toBeNull();
	});

	it("rewrite_rule writes RULE.md with a safe target", async () => {
		const id = pattern({
			kind: "claude_md_rule",
			label: "use httpx not requests",
			meta: { corrections: ["use httpx not requests"] },
		});
		fake.scenario({
			stdout: successResult({
				...DRAFT,
				name: "httpx",
				rule_text: "Use httpx for HTTP; never requests.",
				target_file: "../../x.md",
			}),
		});
		const r = await draftPattern(db, id, cfg(), { mode: "rewrite_rule" });
		expect(r.draftPath.endsWith(join("httpx", "RULE.md"))).toBe(true);
		expect(readFileSync(r.draftPath, "utf8")).toBe("Use httpx for HTTP; never requests.\n");
		expect(draftMeta(db, id)?.targetFile).toBe("CLAUDE.md");
	});

	it("widen keeps the body and name and changes only the description", async () => {
		const id = pattern();
		fake.scenario({ stdout: successResult(DRAFT) });
		const first = await draftPattern(db, id, cfg());
		const before = readFileSync(first.draftPath, "utf8");
		setPatternStatus(db, id, "installed");
		fake.scenario({
			stdout: successResult({ ...DRAFT, name: "ignored", description: "Use for any trivy, scanner or CVE finding." }),
		});
		const r = await draftPattern(db, id, cfg(), { mode: "widen" });
		const after = readFileSync(r.draftPath, "utf8");
		expect(after).toContain("name: trivy-fix");
		expect(frontMatter(after).description).toBe("Use for any trivy, scanner or CVE finding.");
		expect(after.slice(after.indexOf("## Steps"))).toBe(before.slice(before.indexOf("## Steps")));
		expect(getPattern(db, id)?.status).toBe("installed");
	});

	it("a test gap has nothing to draft", async () => {
		const id = pattern({ kind: "test_gap", label: "services/cache.py" });
		await expect(draftPattern(db, id, cfg())).rejects.toBeInstanceOf(InvalidDraftError);
		expect(fake.invocations()).toHaveLength(0);
	});
});

describe("deterministic drafts", () => {
	it("a rule draft with drafts off: RULE.md with one imperative line, no spawn", () => {
		const id = pattern({ kind: "claude_md_rule", label: "use httpx not requests" });
		const { draftPath } = draftDeterministic(db, id);
		expect(readFileSync(draftPath, "utf8")).toBe("Use httpx, not requests.\n");
		expect(draftMeta(db, id)).toMatchObject({ mode: "deterministic", costUsd: 0, targetFile: "CLAUDE.md" });
		expect(getPattern(db, id)?.status).toBe("drafted");
		expect(fake.invocations()).toHaveLength(0);
	});

	it("a pointer draft lists the start-up files", () => {
		const id = pattern({
			kind: "claude_md_pointer",
			label: "Read at session start",
			meta: { readFiles: ["docs/arch.md", "src/config.ts"] },
		});
		const text = readFileSync(draftDeterministic(db, id).draftPath, "utf8");
		expect(text).toContain("- `docs/arch.md`\n- `src/config.ts`");
	});

	it("a skill pattern has no deterministic draft", () => {
		expect(() => draftDeterministic(db, pattern())).toThrow(InvalidDraftError);
	});
});

describe("editor storage", () => {
	it("saveDraft validates the front matter and rewrites only the draft file", async () => {
		const id = pattern();
		fake.scenario({ stdout: successResult(DRAFT) });
		const { draftPath } = await draftPattern(db, id, cfg());
		saveDraft(db, id, "---\nname: trivy-fix\ndescription: Edited.\n---\nNew body\n");
		expect(readDraft(id, db).content).toBe("---\nname: trivy-fix\ndescription: Edited.\n---\nNew body\n");
		expect(() => saveDraft(db, id, "---\nname: Bad Name\ndescription: x\n---\n")).toThrow(/kebab-case/);
		expect(() => saveDraft(db, id, "---\nname: ok\ndescription: ''\n---\n")).toThrow(/description/);
		expect(() => saveDraft(db, id, "---js\n{ name: 'x' }\n---\n")).toThrow(InvalidDraftError);
		expect(() => saveDraft(db, id, "no front matter")).toThrow(/kebab-case/);
		expect(readFileSync(draftPath, "utf8")).toContain("description: Edited.");
		expect(existsSync(join(draftsDir(), "ra", "trivy-fix", "draft.json"))).toBe(true);
	});

	it("readDraft without a draft throws", () => {
		expect(() => readDraft(pattern(), db)).toThrow(InvalidDraftError);
	});

	it("withDescription keeps every body byte", () => {
		const skill = "---\nname: x\ndescription: old\n---\n\nbody  with  spaces\r\nline2";
		expect(withDescription(skill, "new one")).toBe(
			"---\nname: x\ndescription: new one\n---\n\nbody  with  spaces\r\nline2",
		);
	});
});

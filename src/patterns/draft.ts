// Skill and CLAUDE.md drafts (feature 11 "Draft flow"; Phase 5b spec decisions 3, 4): the output schema, the cost
// estimate shown before any draft call, AI drafts through runClaude(), deterministic rule / pointer drafts, and the
// draft files the editor reads and saves. Drafts live only under draftsDir() until an Install click.
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import matter from "gray-matter";
import { z } from "zod";
import { ClaudeError, runClaude } from "../claude/headless";
import { frontMatter } from "../collector/inventory";
import { estimateCost } from "../collector/prices";
import { priceableModel } from "../collector/summarize";
import type { Config } from "../config";
import type { Db } from "../db/adapter";
import { getPattern, type Pattern, setPatternError, setPatternStatus } from "../db/queries/patterns";
import { draftsDir, ensureDir } from "../paths";
import { redactDeep } from "../redact";
import { buildDraftContext, type DraftMode, estimateContextChars, UnknownPatternError } from "./context";

export const DRAFT_OUTPUT_TOKENS = 2000;

const text = (max: number) => z.string().transform((s) => s.trim().slice(0, max));
const nullableText = (max: number) =>
	z
		.string()
		.nullable()
		.optional()
		.transform((s) => (typeof s === "string" && s.trim() ? s.trim().slice(0, max) : null));

/** What a draft call must return (feature 11 schema). Over-long text is cut, not rejected; extra keys dropped. */
export const DraftResultSchema = z.object({
	name: text(200),
	description: text(1024),
	body: text(40_000),
	rule_text: nullableText(1000),
	target_file: nullableText(200),
});
export type DraftOutput = z.output<typeof DraftResultSchema>;

/** The JSON Schema passed to `claude -p --json-schema`. */
export const DRAFT_SCHEMA = {
	type: "object",
	properties: {
		name: { type: "string", description: "kebab-case skill name" },
		description: { type: "string", description: "written to trigger on the observed prompts" },
		body: { type: "string", description: "markdown: when to use, steps that worked, checks to run at the end" },
		rule_text: { type: ["string", "null"] },
		target_file: { type: ["string", "null"], description: "CLAUDE.md or .claude/rules/<name>.md, or null" },
	},
	required: ["name", "description", "body", "rule_text", "target_file"],
	additionalProperties: false,
} as const;

/** The model drafts are priced on: ai.model, else the user's most-used model. */
function draftModel(db: Db, cfg: Config): string | null {
	return (
		cfg.ai.model ??
		db
			.prepare(
				"SELECT model FROM usage WHERE model IS NOT NULL GROUP BY model ORDER BY count(*) DESC, max(ts) DESC LIMIT 1",
			)
			.get<{ model: string }>()?.model ??
		null
	);
}

/**
 * Estimated cost of a draft (feature 11 step 1): ceil(prompt chars / 4) input plus 2,000 output tokens on ai.model or
 * the most-used model. The context is priced without git (all added lines), so the estimate is an upper bound. Null
 * without a priceable model.
 */
export function estimateDraftCost(db: Db, patternId: number, cfg: Config, mode: DraftMode = "create"): number | null {
	const model = draftModel(db, cfg);
	if (!model) return null;
	return estimateCost({
		model: priceableModel(model),
		inputTokens: Math.ceil(estimateContextChars(db, patternId, mode) / 4),
		outputTokens: DRAFT_OUTPUT_TOKENS,
		cacheCreationTokens: 0,
		cacheCreation1hTokens: 0,
		cacheReadTokens: 0,
	});
}

// ---- Drafting (feature 11 "Draft flow" steps 2-7; spec decisions 3, 4) ----

export const DRAFT_TIMEOUT_MS = 180_000;
const SLUG_MAX = 64;

export class DraftsDisabledError extends Error {
	constructor() {
		super("Skill drafts are off: turn them on in Settings");
	}
}

/** A draft file that fails validation (route: 422), or a pattern with nothing to draft (409). */
export class InvalidDraftError extends Error {}

export type DraftResult = { draftPath: string; costUsd: number | null; model?: string };

/** draft.json beside the draft: which pattern, sessions and call produced it, and what install does with it. */
export type DraftMeta = {
	patternId: number;
	sessions: string[];
	costUsd: number | null;
	model: string | null;
	mode: DraftMode | "deterministic";
	createdAt: string;
	/** Rules and pointers: CLAUDE.md or .claude/rules/<slug>.md (never anything else). */
	targetFile?: string;
};

/** kebab-case `[a-z0-9-]`, ≤ 64 chars; empty after slugging → the label's slug, else "skill" (spec decision 4). */
export function slugifySkillName(name: string, fallback: string): string {
	const slug = (s: string) =>
		s
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, SLUG_MAX)
			.replace(/-+$/g, "");
	return slug(name) || slug(fallback) || "skill";
}

/** `CLAUDE.md` or `.claude/rules/<slug>.md`; anything else becomes `CLAUDE.md` (spec decision 4). */
export function safeTargetFile(target: string | null | undefined, slug: string): string {
	const t = (target ?? "").trim().replace(/\\/g, "/");
	if (t === `.claude/rules/${slug}.md`) return t;
	return "CLAUDE.md";
}

const RULES_TARGET = /^\.claude\/rules\/[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;

/**
 * Install's check of a draft.json target: `CLAUDE.md` or `.claude/rules/<kebab slug>.md`, else `CLAUDE.md`. The slug
 * was fixed at draft time from the model's name, so install cannot rebuild it from the label.
 */
export function storedTargetFile(target: string | null | undefined): string {
	const t = (target ?? "").trim().replace(/\\/g, "/");
	const slug = t.slice(".claude/rules/".length, -".md".length);
	return RULES_TARGET.test(t) && slug.length <= SLUG_MAX ? t : "CLAUDE.md";
}

const DRAFT_FILE = { skill: "SKILL.md", rule: "RULE.md" } as const;

function writePrivate(path: string, text: string): void {
	writeFileSync(path, text, { mode: 0o600 });
	if (process.platform !== "win32") chmodSync(path, 0o600); // an overwritten file keeps its old mode otherwise
}

function readMeta(dir: string): DraftMeta | null {
	try {
		return JSON.parse(readFileSync(join(dir, "draft.json"), "utf8")) as DraftMeta;
	} catch {
		return null;
	}
}

/**
 * The pattern's draft directory `draftsDir()/<repo name | user>/<slug>`: its own existing draft's directory when the
 * slug matches, else the first of `<slug>`, `<slug>-2`, … not holding another pattern's draft.
 */
function draftDir(db: Db, p: Pattern, slug: string): string {
	const repoName =
		p.repoId === null
			? "user"
			: (db.prepare("SELECT name FROM repos WHERE repo_id = ?").get<{ name: string }>(p.repoId)?.name ?? p.repoId);
	const base = join(draftsDir(), slugifySkillName(repoName, "repo"));
	for (let i = 1; ; i++) {
		const dir = join(base, i === 1 ? slug : `${slug}-${i}`);
		const meta = existsSync(dir) ? readMeta(dir) : null;
		if (!existsSync(dir) || meta?.patternId === p.id) {
			ensureDir(dir);
			if (process.platform !== "win32") chmodSync(dir, 0o700);
			return dir;
		}
	}
}

function storeDraft(db: Db, p: Pattern, slug: string, file: string, content: string, meta: DraftMeta): string {
	const dir = draftDir(db, p, slug);
	const path = join(dir, file);
	writePrivate(path, content);
	writePrivate(join(dir, "draft.json"), `${JSON.stringify(meta, null, 2)}\n`);
	return path;
}

const skillMd = (name: string, description: string, body: string) =>
	matter.stringify(body.endsWith("\n") ? body : `${body}\n`, { name, description });

/** The SKILL.md a widen draft starts from: the installed file, else the pattern's own draft. */
function baseSkillMd(db: Db, p: Pattern): string | null {
	if (p.inventoryId !== null) {
		const path = db.prepare("SELECT path FROM inventory WHERE id = ?").get<{ path: string }>(p.inventoryId)?.path;
		for (const candidate of path ? [path, join(path, "SKILL.md")] : []) {
			try {
				if (statSync(candidate).isFile()) return readFileSync(candidate, "utf8");
			} catch {
				// not this one
			}
		}
	}
	if (p.draftPath && existsSync(p.draftPath)) return readFileSync(p.draftPath, "utf8");
	return null;
}

/** Replaces only the front matter `description` of a SKILL.md, keeping every body byte. */
export function withDescription(skill: string, description: string): string {
	const m = /^(---[ \t]*\r?\n)([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n|$))/.exec(skill);
	if (!m) throw new InvalidDraftError("the skill has no YAML front matter");
	const fm = frontMatter(skill);
	const yaml = matter
		.stringify("", { ...fm, description })
		.replace(/^---\r?\n/, "")
		.replace(/\r?\n---\r?\n[\s\S]*$/, "");
	return `${m[1]}${yaml}${m[3]}${skill.slice(m[0].length)}`;
}

/**
 * An AI draft by click (drafts on; no daily cap, no retry, no resume): the context from the pattern's sessions, one
 * `claude -p` call, then the files under draftsDir(). create writes SKILL.md from the result; widen writes the current
 * SKILL.md with only the new description; rewrite_rule writes RULE.md. A candidate becomes drafted; an installed
 * pattern keeps its status. A failed call leaves the status as it was, records the error on the pattern and throws.
 */
export async function draftPattern(
	db: Db,
	patternId: number,
	cfg: Config,
	opts: { mode?: DraftMode; timeoutMs?: number; now?: Date } = {},
): Promise<DraftResult> {
	const mode = opts.mode ?? "create";
	if (!cfg.ai.drafts.enabled) throw new DraftsDisabledError();
	const p = getPattern(db, patternId);
	if (!p) throw new UnknownPatternError(patternId);
	if (p.kind === "test_gap") throw new InvalidDraftError("a test gap has nothing to draft");
	if (mode === "widen" && !baseSkillMd(db, p)) throw new InvalidDraftError("no skill to widen");
	const ctx = await buildDraftContext(db, patternId, { mode });
	let call: Awaited<ReturnType<typeof runClaude<unknown>>>;
	try {
		call = await runClaude<unknown>({
			prompt: ctx.prompt,
			schema: DRAFT_SCHEMA,
			feature: "draft",
			model: cfg.ai.model,
			timeoutMs: opts.timeoutMs ?? DRAFT_TIMEOUT_MS,
			db,
		});
	} catch (e) {
		setPatternError(db, patternId, e instanceof Error ? e.message.slice(0, 200) : String(e));
		throw e;
	}
	const parsed = DraftResultSchema.safeParse(call.result);
	if (!parsed.success) {
		const msg = `schema: ${parsed.error.issues[0]?.message ?? "invalid"}`;
		setPatternError(db, patternId, msg);
		throw new ClaudeError("schema", msg);
	}
	const r = redactDeep(parsed.data, cfg.capture.redact, cfg.capture.maxFieldBytes);
	const now = (opts.now ?? new Date()).toISOString();
	const meta: DraftMeta = {
		patternId,
		sessions: ctx.sessions,
		costUsd: call.costUsd,
		model: call.model ?? null,
		mode,
		createdAt: now,
	};
	let path: string;
	if (mode === "rewrite_rule") {
		const slug = slugifySkillName(r.name, p.label);
		const rule = r.rule_text ?? r.body ?? r.description;
		if (!rule) throw new InvalidDraftError("the model returned no rule");
		path = storeDraft(db, p, slug, DRAFT_FILE.rule, `${rule.trim()}\n`, {
			...meta,
			targetFile: safeTargetFile(r.target_file, slug),
		});
	} else if (mode === "widen") {
		const base = baseSkillMd(db, p) as string;
		const name = typeof frontMatter(base).name === "string" ? (frontMatter(base).name as string) : p.label;
		if (!r.description) throw new InvalidDraftError("the model returned no description");
		path = storeDraft(
			db,
			p,
			slugifySkillName(name, p.label),
			DRAFT_FILE.skill,
			withDescription(base, r.description),
			meta,
		);
	} else {
		const slug = slugifySkillName(r.name, p.label);
		if (!r.description) throw new InvalidDraftError("the model returned no description");
		path = storeDraft(db, p, slug, DRAFT_FILE.skill, skillMd(slug, r.description, r.body), meta);
	}
	setPatternStatus(db, patternId, p.status === "candidate" || p.status === "dismissed" ? "drafted" : p.status, {
		draftPath: path,
	});
	setPatternError(db, patternId, null);
	return { draftPath: path, costUsd: call.costUsd, model: call.model };
}

/** "use httpx not requests" → "Use httpx, not requests."; else the sentence capitalized with a full stop. */
export function ruleLine(sentence: string): string {
	const s = sentence.trim().replace(/[.;:,\s]+$/, "");
	const m = /^use\s+([\w.@/-]+),?\s+not\s+([\w.@/-]+)$/i.exec(s);
	const line = m ? `Use ${m[1]}, not ${m[2]}` : s;
	return `${line.charAt(0).toUpperCase()}${line.slice(1)}.`;
}

/**
 * Free deterministic draft (spec decision 3; works with drafts off): RULE.md with the most central correction as one
 * imperative line for claude_md_rule, or a paragraph listing the start-up files for claude_md_pointer.
 */
export function draftDeterministic(db: Db, patternId: number, now: Date = new Date()): { draftPath: string } {
	const p = getPattern(db, patternId);
	if (!p) throw new UnknownPatternError(patternId);
	let text: string;
	let slug: string;
	if (p.kind === "claude_md_rule") {
		text = `${ruleLine(p.label)}\n`;
		slug = slugifySkillName(p.label, "rule");
	} else if (p.kind === "claude_md_pointer") {
		const files = p.meta.readFiles ?? [];
		if (files.length === 0) throw new InvalidDraftError("the pattern has no start-up files");
		text = [
			"Most sessions in this repo start by reading these files; read them first:",
			...files.map((f) => `- \`${f}\``),
			"",
		].join("\n");
		slug = "start-up-files";
	} else {
		throw new InvalidDraftError("only CLAUDE.md rule and pointer patterns have a deterministic draft");
	}
	const path = storeDraft(db, p, slug, DRAFT_FILE.rule, text, {
		patternId,
		sessions: p.sessionIds,
		costUsd: 0,
		model: null,
		mode: "deterministic",
		createdAt: now.toISOString(),
		targetFile: "CLAUDE.md",
	});
	setPatternStatus(db, patternId, p.status === "candidate" || p.status === "dismissed" ? "drafted" : p.status, {
		draftPath: path,
	});
	return { draftPath: path };
}

/** The pattern's draft file and content; throws InvalidDraftError when there is none. */
export function readDraft(patternId: number, db: Db): { path: string; content: string } {
	const p = getPattern(db, patternId);
	if (!p) throw new UnknownPatternError(patternId);
	if (!p.draftPath || !existsSync(p.draftPath)) throw new InvalidDraftError("no draft yet");
	return { path: p.draftPath, content: readFileSync(p.draftPath, "utf8") };
}

/** Throws InvalidDraftError unless a SKILL.md has plain YAML front matter with a slug `name` and a `description`. */
export function validateSkillMd(content: string): { name: string; description: string } {
	let fm: Record<string, unknown>;
	try {
		fm = frontMatter(content);
	} catch (e) {
		throw new InvalidDraftError(`front matter: ${(e as Error).message}`);
	}
	const name = fm.name;
	const description = fm.description;
	if (typeof name !== "string" || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) || name.length > SLUG_MAX) {
		throw new InvalidDraftError("front matter `name` must be kebab-case (a-z, 0-9, -), at most 64 characters");
	}
	if (typeof description !== "string" || !description.trim()) {
		throw new InvalidDraftError("front matter `description` must not be empty");
	}
	return { name, description };
}

/** The editor's save (feature 11 step 6): validates, then rewrites the draft file only. */
export function saveDraft(db: Db, patternId: number, content: string): void {
	const { path } = readDraft(patternId, db);
	if (path.endsWith(DRAFT_FILE.skill)) validateSkillMd(content);
	else if (!content.trim()) throw new InvalidDraftError("the rule must not be empty");
	writePrivate(path, content.endsWith("\n") ? content : `${content}\n`);
}

/** draft.json of the pattern's draft, or null. */
export function draftMeta(db: Db, patternId: number): DraftMeta | null {
	const p = getPattern(db, patternId);
	return p?.draftPath ? readMeta(dirname(p.draftPath)) : null;
}

// Install on click (feature 11 "Install"; Phase 5b spec decision 4): the only code that writes outside
// ~/.cc-debrief/, and only from POST /api/patterns/:id/install. Exactly one of: <repo>/.claude/skills/<slug>/SKILL.md,
// <repo>/CLAUDE.md (append), <repo>/.claude/rules/<slug>.md, <claudeDir()>/skills/<slug>/SKILL.md. Every path is
// checked against its root after realpath, symlinks on the way are refused, and nothing is committed to git.
import {
	appendFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import type { Db } from "../db/adapter";
import { getPattern, type Pattern, setPatternStatus } from "../db/queries/patterns";
import { scanRepoInto, scanUserInto } from "../derive/inventory-usage";
import { claudeDir } from "../paths";
import { UnknownPatternError } from "./context";
import { draftMeta, InvalidDraftError, storedTargetFile, validateSkillMd, withDescription } from "./draft";

export type InstallRefusal = "target_exists" | "repo_missing" | "invalid_draft" | "unsafe_target";

export class UnsafeTargetError extends Error {
	constructor(
		readonly code: InstallRefusal,
		message: string,
	) {
		super(message);
	}
}

export type InstallTarget = {
	/** The root the target must stay inside: the repo root or <claudeDir()>/skills. */
	root: string;
	/** Absolute file to write. */
	file: string;
	/** append to CLAUDE.md, create a new file (refused when it or its skill directory exists), or replace the description. */
	how: "append" | "create" | "describe";
	/** Directory that must not exist yet (a new skill). */
	newDir: string | null;
	repoId: string | null;
	skillName: string | null;
};

const refuse = (code: InstallRefusal, message: string): never => {
	throw new UnsafeTargetError(code, message);
};

function repoRoot(db: Db, p: Pattern): string {
	if (p.repoId === null) return refuse("repo_missing", "the pattern has no repo");
	const root = db
		.prepare("SELECT root_path FROM repos WHERE repo_id = ?")
		.get<{ root_path: string | null }>(p.repoId)?.root_path;
	if (!root || !existsSync(root) || !statSync(root).isDirectory()) {
		return refuse("repo_missing", `the repo is no longer at ${root ?? "a known path"}`);
	}
	return root;
}

/**
 * Throws unsafe_target unless `file` resolves inside `root`: no existing path segment from the root down to the file is
 * a symlink, and the deepest existing ancestor's realpath is within the root's realpath.
 */
export function assertContained(root: string, file: string): void {
	const realRoot = realpathSync.native(root);
	const rel = relative(root, file);
	if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) refuse("unsafe_target", `${file} is outside ${root}`);
	let at = root;
	for (const part of rel.split(sep)) {
		at = join(at, part);
		let st: ReturnType<typeof lstatSync>;
		try {
			st = lstatSync(at);
		} catch {
			break; // the rest does not exist yet
		}
		if (st.isSymbolicLink()) refuse("unsafe_target", `${at} is a symlink`);
		const real = realpathSync.native(at);
		if (real !== realRoot && !real.startsWith(realRoot + sep))
			refuse("unsafe_target", `${at} resolves outside ${root}`);
	}
}

/** Where the pattern's draft would be installed, before any check of the file system beyond the roots. */
export function resolveInstallTarget(db: Db, patternId: number): InstallTarget {
	const p = getPattern(db, patternId);
	if (!p) throw new UnknownPatternError(patternId);
	if (!p.draftPath || !existsSync(p.draftPath)) return refuse("invalid_draft", "no draft to install");
	const meta = draftMeta(db, patternId);
	if (p.kind === "repo_skill" || p.kind === "user_skill") {
		let name: string;
		try {
			name = validateSkillMd(readFileSync(p.draftPath, "utf8")).name;
		} catch (e) {
			return refuse("invalid_draft", e instanceof Error ? e.message : String(e));
		}
		const root = p.kind === "user_skill" ? join(claudeDir(), "skills") : repoRoot(db, p);
		const skillsDir = p.kind === "user_skill" ? root : join(root, ".claude", "skills");
		if (meta?.mode === "widen") {
			const installed =
				p.inventoryId === null
					? undefined
					: db.prepare("SELECT path FROM inventory WHERE id = ?").get<{ path: string }>(p.inventoryId)?.path;
			const file = installed ? (installed.endsWith("SKILL.md") ? installed : join(installed, "SKILL.md")) : null;
			if (!file || !existsSync(file)) return refuse("invalid_draft", "the installed skill is gone");
			return { root, file, how: "describe", newDir: null, repoId: p.repoId, skillName: name };
		}
		const dir = join(skillsDir, name);
		return { root, file: join(dir, "SKILL.md"), how: "create", newDir: dir, repoId: p.repoId, skillName: name };
	}
	if (p.kind === "claude_md_rule" || p.kind === "claude_md_pointer") {
		const root = repoRoot(db, p);
		const target = storedTargetFile(meta?.targetFile);
		const file = join(root, ...target.split("/"));
		return {
			root,
			file,
			how: target === "CLAUDE.md" ? "append" : "create",
			newDir: null,
			repoId: p.repoId,
			skillName: null,
		};
	}
	return refuse("invalid_draft", "a test gap has nothing to install");
}

/** CLAUDE.md after a blank line, with a trailing newline; the existing bytes are kept as they are. */
function appendBlock(existing: string | null, block: string): string {
	const text = block.endsWith("\n") ? block : `${block}\n`;
	if (existing === null || existing === "") return text;
	return `${existing.endsWith("\n") ? "\n" : "\n\n"}${text}`;
}

/**
 * Installs the pattern's draft (feature 11 "Install" steps 2-5): refuses (UnsafeTargetError, nothing written) a
 * missing repo root, an existing skill directory or rule file, an invalid draft, a symlink on the way or a path outside
 * the root; appends to CLAUDE.md, creates a skill or rule file, or replaces only the installed skill's description;
 * rescans the repo (or user) inventory, links the new skill row, and marks the pattern installed. Returns the absolute
 * paths written.
 */
export function installDraft(
	db: Db,
	patternId: number,
	now: Date = new Date(),
): { written: string[]; inventoryId: number | null } {
	const p = getPattern(db, patternId);
	if (!p) throw new UnknownPatternError(patternId);
	const t = resolveInstallTarget(db, patternId);
	if (!existsSync(t.root)) mkdirSync(t.root, { recursive: true }); // <claudeDir()>/skills on a fresh install
	assertContained(t.root, t.file);
	if (t.newDir && existsSync(t.newDir)) refuse("target_exists", `${t.newDir} already exists`);
	if (t.how === "create" && existsSync(t.file)) refuse("target_exists", `${t.file} already exists`);
	const draft = readFileSync(p.draftPath as string, "utf8");
	if (t.how === "describe") {
		let description: string;
		try {
			description = validateSkillMd(draft).description;
		} catch (e) {
			return refuse("invalid_draft", e instanceof Error ? e.message : String(e));
		}
		writeFileSync(t.file, withDescription(readFileSync(t.file, "utf8"), description));
	} else if (t.how === "append") {
		const existing = existsSync(t.file) ? readFileSync(t.file, "utf8") : null;
		if (existing === null) writeFileSync(t.file, appendBlock(null, draft));
		else appendFileSync(t.file, appendBlock(existing, draft));
	} else {
		mkdirSync(dirname(t.file), { recursive: true });
		// The directories just made are checked again before the write.
		assertContained(t.root, t.file);
		writeFileSync(t.file, draft, { flag: "wx" });
	}

	let inventoryId: number | null = null;
	if (t.skillName) {
		if (p.kind === "user_skill") scanUserInto(db, now);
		else if (t.repoId) scanRepoInto(db, t.root, t.repoId, now);
		inventoryId =
			db
				.prepare(
					`SELECT id FROM inventory WHERE kind = 'skill' AND name = ? AND scope = ? AND repo_id IS ?
					 ORDER BY last_seen DESC LIMIT 1`,
				)
				.get<{ id: number }>(
					t.skillName,
					p.kind === "user_skill" ? "user" : "repo",
					p.kind === "user_skill" ? null : t.repoId,
				)?.id ?? null;
	}
	// A widen keeps the pattern installed since its first install; install links (or keeps) the inventory row.
	if (t.how === "describe")
		setPatternStatus(db, patternId, "installed", {
			inventoryId: inventoryId ?? p.inventoryId,
			now: p.installedAt ? new Date(p.installedAt) : now,
		});
	else setPatternStatus(db, patternId, "installed", { inventoryId, now });
	return { written: [t.file], inventoryId };
}

export { InvalidDraftError };

// Git facts for a session (feature 04): repo identity, HEAD now and at a past time, and line counts since a ref.
// Runs only in the async snapshot / enrich workers, never in the hook. Every failure (no repo, no git, a timeout)
// gives null or [], never an exception.
import { readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { execa } from "execa";

export type RepoInfo = {
	root: string; // "/" separators, lowercased drive letter on Windows
	remoteUrl: string | null; // credentials and user names stripped
	branch: string | null; // null when HEAD is detached
	head: string | null; // null in a repo without commits
	name: string;
};

// English messages (the reflog warning is matched below), no prompts, no optional index locks.
const GIT_ENV = { LC_ALL: "C", LANGUAGE: "C", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };

async function git(cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
	try {
		const r = await execa("git", args, {
			cwd,
			timeout: 3000,
			windowsHide: true,
			reject: false,
			env: GIT_ENV,
			stripFinalNewline: true,
		});
		return { ok: r.exitCode === 0 && !r.failed, stdout: String(r.stdout ?? ""), stderr: String(r.stderr ?? "") };
	} catch {
		return { ok: false, stdout: "", stderr: "" };
	}
}

const slashPath = (p: string) =>
	p
		.replace(/\\/g, "/")
		.replace(/\/+$/, "")
		.replace(/^([A-Za-z]):/, (_, d: string) => `${d.toLowerCase()}:`);

/**
 * Normalises a remote URL (feature 04 step 2): `id` = host (lowercased, no port) / path (case kept, no ".git"),
 * `url` = the URL without credentials or user name. Local paths keep their path as the id.
 */
export function normalizeRemote(raw: string): { id: string; url: string } {
	const trimmed = raw.trim();
	// scp-like form: [user@]host:path (not a Windows drive letter, not a URL)
	const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/.exec(trimmed);
	if (scp && scp[1].length > 1) {
		const path = scp[2]
			.replace(/^\/+/, "")
			.replace(/\/+$/, "")
			.replace(/\.git$/, "");
		return { id: `${scp[1].toLowerCase()}/${path}`, url: `${scp[1]}:${scp[2]}` };
	}
	try {
		const u = new URL(trimmed);
		if (u.protocol === "file:") throw new Error("local");
		u.username = "";
		u.password = "";
		const path = decodeURIComponent(u.pathname)
			.replace(/^\/+/, "")
			.replace(/\/+$/, "")
			.replace(/\.git$/, "");
		return { id: `${u.hostname.toLowerCase()}/${path}`, url: u.toString() };
	} catch {
		const local = slashPath(trimmed.replace(/^file:\/\//, ""));
		return { id: local, url: local };
	}
}

export async function repoInfo(cwd: string): Promise<RepoInfo | null> {
	const top = await git(cwd, ["rev-parse", "--show-toplevel"]);
	if (!top.ok || !top.stdout) return null;
	const root = slashPath(top.stdout);
	const [branch, head, remotes] = await Promise.all([
		git(root, ["symbolic-ref", "--short", "-q", "HEAD"]),
		git(root, ["rev-parse", "--verify", "-q", "HEAD"]),
		git(root, ["remote", "-v"]),
	]);
	// "name\turl (fetch)" lines; origin wins, else the first remote listed.
	const urls = new Map<string, string>();
	for (const line of remotes.ok ? remotes.stdout.split("\n") : []) {
		const m = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line.trim());
		if (m && !urls.has(m[1])) urls.set(m[1], m[2]);
	}
	const rawUrl = urls.get("origin") ?? urls.values().next().value ?? null;
	const remote = rawUrl ? normalizeRemote(rawUrl) : null;
	return {
		root,
		remoteUrl: remote?.url ?? null,
		branch: branch.ok && branch.stdout ? branch.stdout : null,
		head: head.ok && head.stdout ? head.stdout : null,
		name: basename(remote?.id ?? root),
	};
}

/** The normalised remote (host/org/repo) when there is one, else the root path. */
export function repoIdFor(info: RepoInfo): string {
	return info.remoteUrl ? normalizeRemote(info.remoteUrl).id : info.root;
}

export async function headSha(root: string): Promise<string | null> {
	const r = await git(root, ["rev-parse", "--verify", "-q", "HEAD"]);
	return r.ok && r.stdout ? r.stdout : null;
}

/**
 * The commit HEAD pointed at a given time: from the reflog (HEAD@{time}), else the last commit before it in
 * the log (git log -1 --before). A reflog that does not reach back that far answers with its oldest entry and a
 * warning; that answer is ignored.
 */
export async function headAt(root: string, isoTime: string): Promise<{ sha: string; source: "reflog" | "log" } | null> {
	const seconds = Math.floor(Date.parse(isoTime) / 1000);
	if (!Number.isFinite(seconds)) return null;
	const reflog = await git(root, ["rev-parse", "--verify", `HEAD@{@${seconds}}`]);
	if (reflog.ok && reflog.stdout && !/only goes back to/i.test(reflog.stderr)) {
		return { sha: reflog.stdout, source: "reflog" };
	}
	const log = await git(root, ["log", "-1", `--before=@${seconds}`, "--format=%H"]);
	return log.ok && log.stdout ? { sha: log.stdout, source: "log" } : null;
}

/**
 * Trimmed `+` lines of every commit on any ref (`git log --all -p`) since a time that touches the given paths
 * (relative to root): squashed or rebased work matches by content. null on any git error or the 3 s timeout. Phase 5b
 * kept lines (restored from the Phase 4 discarded-work check, removed in tuning).
 */
export async function addedLinesSince(root: string, sinceIso: string, paths: string[]): Promise<Set<string> | null> {
	const seconds = Math.floor(Date.parse(sinceIso) / 1000);
	if (!Number.isFinite(seconds) || paths.length === 0) return null;
	const r = await git(root, [
		"log",
		"--all",
		`--since=@${seconds}`,
		"-p",
		"--no-color",
		"--no-ext-diff",
		"--no-renames",
		"--format=",
		"--",
		...paths,
	]);
	if (!r.ok) return null;
	const out = new Set<string>();
	for (const line of r.stdout.split("\n")) {
		if (line.startsWith("+") && !line.startsWith("+++")) out.add(line.slice(1).trim());
	}
	return out;
}

const UNTRACKED_MAX_BYTES = 1_048_576;

/**
 * Lines added / removed per path (relative, "/" separators) between fromRef (default HEAD) and the working tree,
 * including untracked files counted as all lines added. Binary files are skipped.
 */
export async function numstat(
	root: string,
	fromRef: string | null,
): Promise<{ path: string; added: number; removed: number }[]> {
	const [diff, untracked] = await Promise.all([
		git(root, ["diff", "--numstat", "--no-renames", "-z", fromRef ?? "HEAD", "--"]),
		git(root, ["ls-files", "--others", "--exclude-standard", "-z"]),
	]);
	const out: { path: string; added: number; removed: number }[] = [];
	if (diff.ok) {
		for (const record of diff.stdout.split("\0")) {
			const m = /^(\d+|-)\t(\d+|-)\t(.+)$/s.exec(record);
			if (!m || m[1] === "-" || m[2] === "-") continue; // "-" = binary
			out.push({ path: m[3], added: Number(m[1]), removed: Number(m[2]) });
		}
	}
	if (untracked.ok) {
		for (const path of untracked.stdout.split("\0").filter(Boolean)) {
			try {
				const full = join(root, path);
				if (statSync(full).size > UNTRACKED_MAX_BYTES) continue;
				const buf = readFileSync(full);
				if (buf.includes(0)) continue; // binary
				const text = buf.toString("utf8");
				const lines = text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
				out.push({ path, added: lines, removed: 0 });
			} catch {
				// removed meanwhile
			}
		}
	}
	return out;
}

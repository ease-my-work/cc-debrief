import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export type TestRepo = {
	/** The work tree root, as git reports it (real path). */
	root: string;
	git(...args: string[]): string;
	/** Writes files (paths relative to root) and commits them with the given commit time. */
	commit(files: Record<string, string | Buffer>, isoTime: string, message?: string): string;
	cleanup(): void;
};

/** A temp git repo with a fixed identity, LF line endings and no hooks or signing from the user's config. */
export function gitRepo(): TestRepo {
	const base = realpathSync.native(mkdtempSync(join(tmpdir(), "ccd-git-")));
	const root = join(base, "repo");
	mkdirSync(root);
	const env = {
		...process.env,
		GIT_CONFIG_GLOBAL: join(base, "gitconfig"),
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_TERMINAL_PROMPT: "0",
	};
	writeFileSync(env.GIT_CONFIG_GLOBAL, "");
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	git("init", "-q", "-b", "main");
	git("config", "user.email", "test@example.com");
	git("config", "user.name", "Test");
	git("config", "core.autocrlf", "false");
	git("config", "commit.gpgsign", "false");
	return {
		root,
		git,
		commit(files, isoTime, message = "commit") {
			for (const [path, content] of Object.entries(files)) {
				mkdirSync(dirname(join(root, path)), { recursive: true });
				writeFileSync(join(root, path), content);
			}
			git("add", "-A");
			execFileSync("git", ["commit", "-q", "-m", message], {
				cwd: root,
				env: { ...env, GIT_AUTHOR_DATE: isoTime, GIT_COMMITTER_DATE: isoTime },
				stdio: "ignore",
			});
			return git("rev-parse", "HEAD");
		},
		cleanup: () => rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
	};
}

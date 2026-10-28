import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { headAt, headSha, normalizeRemote, numstat, repoIdFor, repoInfo } from "../../src/collector/git";
import { gitRepo, type TestRepo } from "../helpers/git-repo";

let repo: TestRepo;
beforeEach(() => {
	repo = gitRepo();
});
afterEach(() => repo.cleanup());

const T1 = "2026-01-01T10:00:00.000Z";
const T2 = "2026-01-01T12:00:00.000Z";
const slashRoot = (p: string) => p.replace(/\\/g, "/").replace(/^([A-Z]):/, (_, d: string) => `${d.toLowerCase()}:`);

describe("repoInfo", () => {
	it("returns null outside a git work tree", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ccd-nogit-"));
		try {
			expect(await repoInfo(dir)).toBeNull();
			expect(await repoInfo(join(dir, "missing"))).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("uses the root path as the id when there is no remote", async () => {
		const sha = repo.commit({ "a.txt": "a\n" }, T1);
		mkdirSync(join(repo.root, "sub"));
		const info = await repoInfo(join(repo.root, "sub"));
		expect(info).toEqual({
			root: slashRoot(repo.root),
			remoteUrl: null,
			branch: "main",
			head: sha,
			name: basename(repo.root),
		});
		expect(repoIdFor(info as NonNullable<typeof info>)).toBe(slashRoot(repo.root));
	});

	it("gives an empty repo no head", async () => {
		expect(await repoInfo(repo.root)).toMatchObject({ head: null, branch: "main" });
	});

	it.each([
		"git@github.com:Org/Repo.git",
		"https://github.com/Org/Repo",
		"https://x:tok@GitHub.com/Org/Repo.git",
		"ssh://git@github.com/Org/Repo.git",
		"ssh://git@github.com:22/Org/Repo.git/",
	])("normalises the remote %s", async (url) => {
		repo.commit({ "a.txt": "a" }, T1);
		repo.git("remote", "add", "origin", url);
		const info = await repoInfo(repo.root);
		expect(info && repoIdFor(info)).toBe("github.com/Org/Repo");
		expect(info?.remoteUrl).not.toMatch(/tok|x:|git@/);
		expect(info?.name).toBe("Repo");
	});

	it("prefers origin over the first remote", async () => {
		repo.commit({ "a.txt": "a" }, T1);
		repo.git("remote", "add", "aaa", "https://gitlab.com/other/thing.git");
		repo.git("remote", "add", "origin", "https://github.com/Org/Repo.git");
		const info = await repoInfo(repo.root);
		expect(info && repoIdFor(info)).toBe("github.com/Org/Repo");
	});

	it("uses the first remote when there is no origin", async () => {
		repo.commit({ "a.txt": "a" }, T1);
		repo.git("remote", "add", "upstream", "https://gitlab.com/Team/Proj.git");
		const info = await repoInfo(repo.root);
		expect(info && repoIdFor(info)).toBe("gitlab.com/Team/Proj");
	});

	it("reports a detached HEAD with no branch", async () => {
		const first = repo.commit({ "a.txt": "a" }, T1);
		repo.commit({ "a.txt": "b" }, T2);
		repo.git("checkout", "-q", "--detach", first);
		expect(await repoInfo(repo.root)).toMatchObject({ branch: null, head: first });
	});
});

describe("normalizeRemote", () => {
	it.each([
		["git@bitbucket.org:team/app.git", "bitbucket.org/team/app"],
		["https://dev.azure.com/org/proj/_git/repo", "dev.azure.com/org/proj/_git/repo"],
		["git://example.com/a/b.git", "example.com/a/b"],
	])("%s → %s", (url, id) => {
		expect(normalizeRemote(url).id).toBe(id);
	});

	it("strips credentials and ssh users from the stored url", () => {
		expect(normalizeRemote("https://u:secret@host.com/a/b.git").url).toBe("https://host.com/a/b.git");
		expect(normalizeRemote("ssh://me@host.com/a/b.git").url).toBe("ssh://host.com/a/b.git");
		expect(normalizeRemote("me@host.com:a/b.git").url).toBe("host.com:a/b.git");
	});
});

describe("HEAD", () => {
	it("headSha returns the current commit, null outside a repo", async () => {
		const sha = repo.commit({ "a.txt": "a" }, T1);
		expect(await headSha(repo.root)).toBe(sha);
		expect(await headSha(join(repo.root, "..", "nope"))).toBeNull();
	});

	it("headAt finds the commit at a time from the reflog, then from the log", async () => {
		const first = repo.commit({ "a.txt": "a" }, T1);
		repo.commit({ "a.txt": "b" }, T2);
		expect(await headAt(repo.root, "2026-01-01T11:00:00.000Z")).toEqual({ sha: first, source: "reflog" });
		repo.git("reflog", "expire", "--expire=now", "--all");
		expect(await headAt(repo.root, "2026-01-01T11:00:00.000Z")).toEqual({ sha: first, source: "log" });
	});

	it("headAt ignores the reflog's oldest entry for a time before it, and returns null before any commit", async () => {
		repo.commit({ "a.txt": "a" }, T1);
		expect(await headAt(repo.root, "2025-06-01T00:00:00.000Z")).toBeNull();
	});
});

describe("numstat", () => {
	it("counts changed, committed and new files since a ref, skipping binaries", async () => {
		const first = repo.commit({ "a.txt": "1\n2\n3\n", "bin.dat": Buffer.from([0, 1, 2, 0]) }, T1);
		repo.commit({ "a.txt": "1\n2\nthree\n4\n" }, T2);
		writeFileSync(join(repo.root, "a.txt"), "1\n2\nthree\n4\n5\n"); // uncommitted edit
		writeFileSync(join(repo.root, "bin.dat"), Buffer.from([0, 9, 9, 0]));
		mkdirSync(join(repo.root, "src"));
		writeFileSync(join(repo.root, "src", "new file.ts"), "x\ny\n"); // untracked
		writeFileSync(join(repo.root, "new.bin"), Buffer.from([0, 0, 1]));
		const rows = await numstat(repo.root, first);
		expect(rows.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
			{ path: "a.txt", added: 3, removed: 1 },
			{ path: "src/new file.ts", added: 2, removed: 0 },
		]);
	});

	it("diffs against HEAD when no ref is given", async () => {
		repo.commit({ "a.txt": "1\n" }, T1);
		writeFileSync(join(repo.root, "a.txt"), "1\n2\n");
		expect(await numstat(repo.root, null)).toEqual([{ path: "a.txt", added: 1, removed: 0 }]);
	});
});

describe("without git on PATH", () => {
	let saved: string | undefined;
	beforeEach(() => {
		saved = process.env.PATH;
		process.env.PATH = "";
	});
	afterEach(() => {
		process.env.PATH = saved;
	});

	it("returns null / [] and never throws", async () => {
		expect(await repoInfo(repo.root)).toBeNull();
		expect(await headSha(repo.root)).toBeNull();
		expect(await headAt(repo.root, T2)).toBeNull();
		expect(await numstat(repo.root, "HEAD")).toEqual([]);
	});
});

import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../../src/db/adapter";
import { encodePayload } from "../../../src/ingest/line";
import { addedLines, keptAddedLines } from "../../../src/patterns/kept-lines";
import { gitRepo, type TestRepo } from "../../helpers/git-repo";
import { seedDb } from "../../helpers/seed";
import { type TmpHome, tmpHome } from "../../helpers/tmp-home";

let h: TmpHome;
let db: Db;
let repo: TestRepo;
beforeEach(() => {
	h = tmpHome();
	db = seedDb();
	repo = gitRepo();
	repo.commit({ "README.md": "# app\n" }, "2026-10-01T09:00:00Z");
	db.prepare("INSERT INTO repos (repo_id, root_path, name) VALUES ('ra', ?, 'app')").run(repo.root);
	db.prepare(
		"INSERT INTO sessions (session_id, started_at, ended_at, repo_id) VALUES ('s1', '2026-10-02T09:00:00Z', '2026-10-02T10:00:00Z', 'ra')",
	).run();
});
afterEach(() => {
	db.close();
	repo.cleanup();
	h.cleanup();
});

let n = 0;
/** An Edit call whose structuredPatch adds `lines` to `path`, with its file_changes row. */
function edit(path: string, lines: string[]): void {
	const id = Number(
		db
			.prepare(
				`INSERT INTO tool_calls (session_id, tool_use_id, tool_name, input, response, started_at, ok)
				 VALUES ('s1', ?, 'Edit', ?, ?, ?, 1)`,
			)
			.run(
				`tu-${++n}`,
				encodePayload({ file_path: `${repo.root}/${path}`, old_string: "x", new_string: lines.join("\n") }),
				encodePayload({ toolUseResult: { structuredPatch: [{ lines: lines.map((l) => `+${l}`) }] } }),
				`2026-10-02T09:0${n}:00Z`,
			).lastInsertRowid,
	);
	db.prepare(
		"INSERT INTO file_changes (session_id, tool_call_id, repo_id, path, lines_added) VALUES ('s1', ?, 'ra', ?, ?)",
	).run(id, path, lines.length);
}

describe("addedLines", () => {
	it("takes structuredPatch + lines, else the input", () => {
		expect(
			addedLines("Edit", {}, { toolUseResult: { structuredPatch: [{ lines: [" ctx", "-old", "+new"] }] } }),
		).toEqual(["new"]);
		expect(addedLines("Edit", { old_string: "a\nb", new_string: "a\nc" }, {})).toEqual(["c"]);
		expect(addedLines("Write", { content: "x\ny" }, {})).toEqual(["x", "y"]);
		expect(addedLines("MultiEdit", { edits: [{ old_string: "", new_string: "z" }] }, {})).toEqual(["z"]);
	});
});

describe("keptAddedLines", () => {
	it("keeps committed lines, drops discarded ones and lines under 4 characters", async () => {
		edit("src/retry.ts", ["export const RETRIES = 3;", "const discarded = true;", "}", "  "]);
		repo.commit({ "src/retry.ts": "export const RETRIES = 3;\n}\n" }, "2026-10-02T09:30:00Z");
		expect(await keptAddedLines(db, "s1")).toEqual({
			lines: [{ path: "src/retry.ts", text: "export const RETRIES = 3;" }],
			verified: true,
		});
	});

	it("matches squash-merged work by content on any ref", async () => {
		edit("src/a.ts", ["function alpha() { return 1; }"]);
		repo.git("checkout", "-q", "-b", "feature");
		repo.commit({ "src/a.ts": "function alpha() { return 1; }\n" }, "2026-10-02T09:40:00Z");
		repo.git("checkout", "-q", "main");
		expect((await keptAddedLines(db, "s1")).lines.map((l) => l.text)).toEqual(["function alpha() { return 1; }"]);
	});

	it("a line committed before the session started does not count as kept", async () => {
		repo.commit({ "src/b.ts": "const old = 'before';\n" }, "2026-10-01T10:00:00Z");
		edit("src/b.ts", ["const old = 'before';"]);
		expect((await keptAddedLines(db, "s1")).lines).toEqual([]);
	});

	it("repo gone: every added line, verified false", async () => {
		edit("src/c.ts", ["const kept = 'maybe';"]);
		const root = repo.root;
		repo.cleanup();
		rmSync(root, { recursive: true, force: true });
		expect(await keptAddedLines(db, "s1")).toEqual({
			lines: [{ path: "src/c.ts", text: "const kept = 'maybe';" }],
			verified: false,
		});
	});

	it("no added lines: empty and verified", async () => {
		expect(await keptAddedLines(db, "s1")).toEqual({ lines: [], verified: true });
	});
});

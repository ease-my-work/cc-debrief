// Phase 7 Global Constraints (final review I5): no new route carries prompt text or a session folder path. The
// session's prompt holds LEAK_PROMPT and its cwd, file edits, tool inputs and memory are under LEAK_FOLDER. Repo ids
// are identifiers (the existing /api/repos precedent, architecture "As built in Phase 7"), so the repo root is not
// under LEAK_FOLDER here.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { projectSlug } from "../../../src/collector/memory";
import type { Db } from "../../../src/db/adapter";
import { encodePayload } from "../../../src/ingest/line";
import { createApp } from "../../../src/server/app";
import { LEAK_FOLDER, LEAK_PROMPT, seedParitySession } from "../../helpers/parity-seed";
import { seedDb } from "../../helpers/seed";
import { type TmpHome, tmpHome } from "../../helpers/tmp-home";

const ROOT = "/home/u/code/api";
const REPO = { id: "github.com/acme/api", name: "api", root: ROOT };
const LOCAL = { id: "/home/u/code/scratch", name: "scratch", root: "/home/u/code/scratch" }; // no remote: id is the root

let h: TmpHome;
let db: Db;
beforeEach(() => {
	h = tmpHome();
	db = seedDb();
	const at = new Date(Date.now() - 3_600_000).toISOString();
	const leakDir = `/home/u/${LEAK_FOLDER}/work`;
	seedParitySession(db, "s1", {
		startedAt: at,
		repo: REPO,
		cwd: leakDir,
		prompt: `do ${LEAK_PROMPT}`,
		permissionMode: "plan",
		ccVersion: "2.1.300",
		usage: [{ input: 1000, ts: at }],
	});
	seedParitySession(db, "s2", { startedAt: at, repo: LOCAL, cwd: leakDir, prompt: LEAK_PROMPT, usage: [{ input: 5 }] });
	db.prepare(
		"INSERT INTO file_changes (session_id, repo_id, path, lines_added, language) VALUES ('s1', ?, ?, 3, 'typescript')",
	).run(REPO.id, `${leakDir}/x.ts`);
	db.prepare(
		"INSERT INTO tool_calls (session_id, tool_name, input, ok, started_at) VALUES ('s1', 'Read', ?, 1, ?)",
	).run(encodePayload({ file_path: `${leakDir}/x.ts` }), at);
	const mem = join(h.claude, "projects", projectSlug(ROOT), "memory");
	mkdirSync(mem, { recursive: true });
	writeFileSync(join(mem, "MEMORY.md"), "# Memory\n");
});
afterEach(() => {
	db.close();
	h.cleanup();
});

/** Route → the part of its body Phase 7 added (Overview recent rows and Repo detail files predate it). */
const PHASE7_PART: Record<string, (b: Record<string, unknown>) => unknown> = {
	"/api/overview?range=all": (b) => [(b.tiles as { sessions: unknown }).sessions, b.budget],
	[`/api/repos/${encodeURIComponent(REPO.id)}?range=all`]: (b) => [
		b.languages,
		b.branches,
		b.used,
		b.topTools,
		b.perWeek,
	],
};

const ROUTES = [
	"/api/overview?range=all",
	"/api/adoption?range=all",
	"/api/versions",
	`/api/repos/${encodeURIComponent(REPO.id)}?range=all`,
	`/api/repos/${encodeURIComponent(REPO.id)}/memory`,
	"/api/tools?range=all",
	"/api/config",
	"/api/inventory?kind=agent&range=all",
];

describe("no prompt text or session folder in the Phase 7 routes", () => {
	it.each(ROUTES)("%s", async (route) => {
		const r = await createApp(db, { port: 4242, uiDir: "/x" }).request(route, { headers: { host: "localhost:4242" } });
		expect(r.status).toBe(200);
		const raw = await r.text();
		const part = PHASE7_PART[route];
		const text = part ? JSON.stringify(part(JSON.parse(raw))) : raw;
		expect(text).not.toContain(LEAK_PROMPT);
		expect(text).not.toContain(LEAK_FOLDER);
	});
});

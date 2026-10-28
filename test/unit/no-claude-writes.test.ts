// Claude Code's own directory is read-only to capture: only init / uninit write settings.json (not run here).
// Every file under CLAUDE_CONFIG_DIR is hashed before and after the backfill, all hook events, snapshot and enrich.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setConfigValue } from "../../src/config";
import type { Db } from "../../src/db/adapter";
import { enrichPending, snapshotSession } from "../../src/enrich";
import { runHook } from "../../src/hook/run";
import { ingestPending } from "../../src/ingest/ingest";
import { copyFixtureInto, hookFixtures, loadFixtureCases } from "../helpers/fixtures";
import { gitRepo, type TestRepo } from "../helpers/git-repo";
import { seedDb } from "../helpers/seed";
import { type TmpHome, tmpHome } from "../helpers/tmp-home";

let h: TmpHome;
let db: Db;
let repo: TestRepo;
beforeEach(() => {
	h = tmpHome();
	setConfigValue("retention.days", "0");
	db = seedDb();
	repo = gitRepo();
	repo.commit({ "README.md": "# app\n" }, "2026-09-29T09:00:00Z");
});
afterEach(() => {
	db.close();
	repo.cleanup();
	h.cleanup();
});

function hashes(dir: string): Record<string, string> {
	const out: Record<string, string> = {};
	const walk = (d: string) => {
		for (const name of readdirSync(d)) {
			const p = join(d, name);
			const st = statSync(p);
			if (st.isDirectory()) walk(p);
			else out[relative(dir, p)] = `${createHash("sha256").update(readFileSync(p)).digest("hex")}:${st.mtimeMs}`;
		}
	};
	walk(dir);
	return out;
}

describe("no writes under the Claude Code directory", () => {
	it("backfill, hooks, snapshot and enrich leave every file there as it was", async () => {
		for (const c of loadFixtureCases()) copyFixtureInto(h.claude, c.caseDir);
		writeFileSync(join(h.claude, "settings.json"), '{\n  "model": "opus"\n}\n');
		const before = hashes(h.claude);
		expect(Object.keys(before).length).toBeGreaterThanOrEqual(20);

		const r = ingestPending(db);
		for (const f of hookFixtures()) await runHook(f.raw, {}, db, { spawn: () => {} });
		await snapshotSession(db, r.sessions[0], repo.root);
		await enrichPending(db, { ai: false });

		expect(hashes(h.claude)).toEqual(before);
	});
});

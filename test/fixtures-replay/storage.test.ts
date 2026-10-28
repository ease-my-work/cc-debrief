// Storage budget (Phase 0 D1, revised 2026-09-30): at most 80 MB per 100 sessions including derived tables.
// Measured on the committed Phase 0 fixtures after VACUUM.
import { statSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setConfigValue } from "../../src/config";
import type { Db } from "../../src/db/adapter";
import { ingestPending } from "../../src/ingest/ingest";
import { dbPath } from "../../src/paths";
import { copyFixtureInto, loadFixtureCases } from "../helpers/fixtures";
import { seedDb } from "../helpers/seed";
import { type TmpHome, tmpHome } from "../helpers/tmp-home";

let h: TmpHome;
let db: Db;
beforeEach(() => {
	h = tmpHome();
	setConfigValue("retention.days", "0");
	db = seedDb();
});
afterEach(() => {
	db.close();
	h.cleanup();
});

describe("storage", () => {
	it("stays within 0.8 MB per main session after VACUUM, with 8 KB pages", () => {
		for (const c of loadFixtureCases()) copyFixtureInto(h.claude, c.caseDir);
		ingestPending(db);
		const sessions = (
			db
				.prepare("SELECT count(DISTINCT session_id) AS n FROM transcripts WHERE agent_id IS NULL AND internal = 0")
				.get() as {
				n: number;
			}
		).n;
		db.exec("PRAGMA wal_checkpoint(TRUNCATE); VACUUM;");
		const bytes = statSync(dbPath()).size;
		const perSession = bytes / sessions / 1024 / 1024;
		console.log(
			`storage: ${(bytes / 1024 / 1024).toFixed(2)} MB for ${sessions} sessions = ${perSession.toFixed(3)} MB each`,
		);
		expect(Object.values(db.prepare("PRAGMA page_size").get() as object)[0]).toBe(8192);
		expect(sessions).toBeGreaterThanOrEqual(9);
		expect(perSession).toBeLessThanOrEqual(0.8);
	});
});

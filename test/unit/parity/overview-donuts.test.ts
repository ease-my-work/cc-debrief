// Phase 7 Task 9 (P13): sessions by repo for the Overview donut — top 6 + "other", sessions outside a repo as "no repo".
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../../../src/db/adapter";
import { migrate } from "../../../src/db/migrate";
import { getOverview } from "../../../src/db/queries/overview";
import { localAt, PARITY_NOW, seedParitySession } from "../../helpers/parity-seed";

let db: Db;
beforeEach(() => {
	db = openDb(":memory:");
	migrate(db);
});
afterEach(() => db.close());

let n = 0;
const sessions = (repo: string | null, count: number) => {
	for (let i = 0; i < count; i++)
		seedParitySession(db, `s${n++}`, {
			startedAt: localAt(1, 9),
			repo: repo ? { id: `github.com/acme/${repo}`, name: repo } : null,
		});
};

describe("Overview sessions by repo", () => {
	it("lists the top 6 repos by sessions, then the rest as other", () => {
		["a", "b", "c", "d", "e", "f", "g", "h"].forEach((r, i) => {
			sessions(r, 10 - i);
		});
		const byRepo = getOverview(db, { range: "7d", now: PARITY_NOW }).tiles.sessions.byRepo;
		expect(byRepo).toEqual([
			{ repoId: "github.com/acme/a", name: "a", sessions: 10 },
			{ repoId: "github.com/acme/b", name: "b", sessions: 9 },
			{ repoId: "github.com/acme/c", name: "c", sessions: 8 },
			{ repoId: "github.com/acme/d", name: "d", sessions: 7 },
			{ repoId: "github.com/acme/e", name: "e", sessions: 6 },
			{ repoId: "github.com/acme/f", name: "f", sessions: 5 },
			{ repoId: null, name: "other", sessions: 4 + 3 },
		]);
	});

	it("counts sessions outside a repo as no repo, and an empty range as []", () => {
		sessions(null, 2);
		sessions("a", 1);
		expect(getOverview(db, { range: "7d", now: PARITY_NOW }).tiles.sessions.byRepo).toEqual([
			{ repoId: null, name: "no repo", sessions: 2 },
			{ repoId: "github.com/acme/a", name: "a", sessions: 1 },
		]);
		expect(getOverview(db, { range: "today", now: PARITY_NOW }).tiles.sessions.byRepo).toEqual([]);
	});
});

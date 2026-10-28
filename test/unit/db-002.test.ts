import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../../src/db/adapter";
import { migrate } from "../../src/db/migrate";
import init001 from "../../src/db/migrations/001_init.sql";
import { getMeta, setMeta } from "../../src/db/queries/meta";
import { seedDb } from "../helpers/seed";
import { type TmpHome, tmpHome } from "../helpers/tmp-home";

let t: TmpHome;
let db: Db;
beforeEach(() => {
	t = tmpHome();
});
afterEach(() => {
	db?.close();
	t.cleanup();
});

const columns = (table: string) =>
	db
		.prepare(`PRAGMA table_info(${table})`)
		.all<{ name: string; dflt_value: string | null; notnull: number }>()
		.map((c) => c.name);

const addItem = (repoId: string | null, name = "code-review") =>
	db
		.prepare(
			`INSERT INTO inventory (scope, repo_id, kind, name, path, first_seen, last_seen)
			 VALUES (?, ?, 'skill', ?, '/p', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')`,
		)
		.run(repoId === null ? "user" : "repo", repoId, name);

describe("migration 002_inventory", () => {
	it("brings a fresh DB to schema_version 2 with inventory tables that carry agent columns", () => {
		db = seedDb();
		expect(getMeta(db, "schema_version")).toBe("9");
		expect(columns("inventory")).toEqual([
			"id",
			"scope",
			"repo_id",
			"kind",
			"name",
			"path",
			"description",
			"first_seen",
			"last_seen",
			"meta",
			"agent",
		]);
		expect(columns("inventory_usage")).toEqual(["inventory_id", "session_id", "loaded", "invoked", "agent"]);
	});

	it("upgrades a v1 DB without touching its rows", () => {
		db = openDb();
		db.transaction(() => {
			db.exec(init001);
			setMeta(db, "schema_version", "1");
		});
		db.prepare("INSERT INTO sessions (session_id, started_at) VALUES ('s1', '2026-10-01T10:00:00Z')").run();
		migrate(db);
		expect(getMeta(db, "schema_version")).toBe("9");
		expect(db.prepare("SELECT session_id, started_at FROM sessions").all()).toEqual([
			{ session_id: "s1", started_at: "2026-10-01T10:00:00Z" },
		]);
		expect(db.prepare("SELECT count(*) AS n FROM inventory").get()).toEqual({ n: 0 });
	});

	it("treats a NULL repo_id as its own identity in the unique index", () => {
		db = seedDb();
		addItem(null);
		addItem("r");
		expect(() => addItem(null)).toThrow(/UNIQUE/);
		expect(() => addItem("r")).toThrow(/UNIQUE/);
	});

	it("rejects an unknown scope or kind", () => {
		db = seedDb();
		const bad = (scope: string, kind: string) =>
			db
				.prepare(
					`INSERT INTO inventory (scope, kind, name, path, first_seen, last_seen) VALUES (?, ?, 'x', '', 't', 't')`,
				)
				.run(scope, kind);
		expect(() => bad("global", "skill")).toThrow(/CHECK/);
		expect(() => bad("user", "theme")).toThrow(/CHECK/); // Phase 7 (009) added agent, command, output_style, rule, workflow
	});

	it("drops a session's inventory_usage rows when the session is deleted", () => {
		db = seedDb();
		const id = Number(addItem(null).lastInsertRowid);
		db.prepare("INSERT INTO sessions (session_id) VALUES ('s1'), ('s2')").run();
		db.prepare("INSERT INTO inventory_usage (inventory_id, session_id, loaded) VALUES (?, 's1', 1), (?, 's2', 1)").run(
			id,
			id,
		);
		db.prepare("DELETE FROM sessions WHERE session_id = 's1'").run();
		expect(db.prepare("SELECT session_id FROM inventory_usage").all()).toEqual([{ session_id: "s2" }]);
	});

	it("finds invoked rows through a partial index, not a scan of every usage row", () => {
		db = seedDb();
		const plan = db
			.prepare(
				`EXPLAIN QUERY PLAN SELECT u.inventory_id, max(s.started_at) FROM inventory_usage u
				 JOIN sessions s ON s.session_id = u.session_id WHERE u.invoked = 1 GROUP BY u.inventory_id`,
			)
			.all<{ detail: string }>()
			.map((r) => r.detail)
			.join(" | ");
		expect(plan).toContain("inventory_usage_invoked");
	});

	it("keys inventory_usage by (inventory_id, session_id)", () => {
		db = seedDb();
		const id = Number(addItem(null).lastInsertRowid);
		db.prepare("INSERT INTO sessions (session_id) VALUES ('s1')").run();
		const ins = db.prepare("INSERT INTO inventory_usage (inventory_id, session_id) VALUES (?, 's1')");
		ins.run(id);
		expect(() => ins.run(id)).toThrow(/UNIQUE|PRIMARY/);
	});
});

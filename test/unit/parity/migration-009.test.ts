// Phase 7 Task 13 (spec decision 2): 009_inventory_kinds.sql widens inventory.kind and keeps every row id, so
// inventory_usage and patterns.inventory_id stay valid.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../../../src/db/adapter";
import { migrate } from "../../../src/db/migrate";
import { getMeta } from "../../../src/db/queries/meta";

let db: Db;
beforeEach(() => {
	db = openDb(":memory:");
});
afterEach(() => db.close());

const seedV8 = () => {
	migrate(db, { to: 8 });
	db.prepare("INSERT INTO sessions (session_id, started_at) VALUES ('s1', '2026-10-01T10:00:00Z')").run();
	const inv = db.prepare(
		`INSERT INTO inventory (id, scope, repo_id, kind, name, path, first_seen, last_seen, meta)
		 VALUES (?, 'user', NULL, ?, ?, '/p', '2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z', '{"x":1}')`,
	);
	inv.run(7, "skill", "pdf");
	inv.run(42, "mcp", "github");
	db.prepare("INSERT INTO inventory_usage (inventory_id, session_id, loaded, invoked) VALUES (7, 's1', 1, 1)").run();
	db.prepare("INSERT INTO inventory_usage (inventory_id, session_id, loaded, invoked) VALUES (42, 's1', 1, 0)").run();
	db.prepare(
		`INSERT INTO patterns (repo_id, label, label_norm, kind, first_seen, last_seen, status, inventory_id)
		 VALUES (NULL, 'p', 'p', 'user_skill', '2026-09-01', '2026-10-01', 'installed', 7)`,
	).run();
};

describe("migration 009", () => {
	it("keeps inventory rows with their ids, usage rows and pattern links; foreign keys check clean", () => {
		seedV8();
		migrate(db);
		expect(getMeta(db, "schema_version")).toBe("9");
		expect(db.prepare("SELECT id, kind, name, meta FROM inventory ORDER BY id").all()).toEqual([
			{ id: 7, kind: "skill", name: "pdf", meta: '{"x":1}' },
			{ id: 42, kind: "mcp", name: "github", meta: '{"x":1}' },
		]);
		expect(db.prepare("SELECT inventory_id, invoked FROM inventory_usage ORDER BY inventory_id").all()).toEqual([
			{ inventory_id: 7, invoked: 1 },
			{ inventory_id: 42, invoked: 0 },
		]);
		expect(db.prepare("SELECT inventory_id FROM patterns").all()).toEqual([{ inventory_id: 7 }]);
		expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
		expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
	});

	it("accepts the new kinds and still rejects unknown ones and duplicate identities", () => {
		migrate(db);
		const insert = db.prepare(
			`INSERT INTO inventory (scope, kind, name, path, first_seen, last_seen) VALUES ('user', ?, ?, '/p', 'x', 'x')`,
		);
		for (const kind of ["agent", "command", "output_style", "rule", "workflow"]) insert.run(kind, `n-${kind}`);
		expect(() => insert.run("bogus", "b")).toThrow();
		expect(() => insert.run("agent", "n-agent")).toThrow();
	});

	it("still cascades a deleted inventory row to its usage rows", () => {
		seedV8();
		migrate(db);
		db.prepare("DELETE FROM inventory WHERE id = 7").run();
		expect(db.prepare("SELECT count(*) AS n FROM inventory_usage WHERE inventory_id = 7").get()).toEqual({ n: 0 });
		expect(db.prepare("SELECT inventory_id FROM patterns").all()).toEqual([{ inventory_id: null }]);
	});
});

import { spawn, spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../../src/db/adapter";
import { migrate } from "../../src/db/migrate";
import { getMeta, setMeta } from "../../src/db/queries/meta";
import { dbPath, ensureDir } from "../../src/paths";
import { bundleScript } from "../helpers/bundle";
import { seedDb } from "../helpers/seed";
import { type TmpHome, tmpHome } from "../helpers/tmp-home";

let t: TmpHome;
beforeEach(() => {
	t = tmpHome();
});
afterEach(() => t.cleanup());

const pragma = (db: ReturnType<typeof openDb>, name: string) =>
	Object.values(db.prepare(`PRAGMA ${name}`).get() as object)[0];

describe("openDb", () => {
	it("creates the file and its dir with 8 KB pages, WAL, foreign keys and a busy timeout", () => {
		const db = openDb();
		try {
			expect(existsSync(dbPath())).toBe(true);
			expect(pragma(db, "page_size")).toBe(8192);
			expect(pragma(db, "journal_mode")).toBe("wal");
			expect(pragma(db, "foreign_keys")).toBe(1);
			expect(pragma(db, "busy_timeout")).toBe(2000);
		} finally {
			db.close();
		}
	});

	it("keeps the page size of an existing 4 KB-page file", () => {
		ensureDir(t.home);
		const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
		const first = new DatabaseSync(join(t.home, "old.db"));
		first.exec("PRAGMA page_size = 4096; CREATE TABLE x (a);");
		first.close();
		const db = openDb(join(t.home, "old.db"));
		try {
			expect(pragma(db, "page_size")).toBe(4096);
			expect(pragma(db, "journal_mode")).toBe("wal");
		} finally {
			db.close();
		}
	});

	it("waits for a lock while switching to WAL instead of failing at once", async () => {
		// A rollback-journal file with another process mid-read: journal_mode = WAL needs the lock, so the busy
		// timeout must already be set when it runs.
		ensureDir(t.home);
		const { DatabaseSync } = await import("node:sqlite");
		const setup = new DatabaseSync(dbPath());
		setup.exec("CREATE TABLE t (x); INSERT INTO t VALUES (1)");
		setup.close();
		const holder = spawn(
			process.execPath,
			[
				"-e",
				`const { DatabaseSync } = require("node:sqlite");
				 const db = new DatabaseSync(${JSON.stringify(dbPath())});
				 db.exec("BEGIN; SELECT * FROM t");
				 process.stdout.write("held");
				 setTimeout(() => { db.exec("COMMIT"); db.close(); }, 400);`,
			],
			{ stdio: ["ignore", "pipe", "ignore"] },
		);
		await new Promise<void>((r) => holder.stdout.once("data", () => r()));
		const db = openDb();
		try {
			expect(pragma(db, "journal_mode")).toBe("wal");
		} finally {
			db.close();
			await new Promise((r) => holder.once("exit", r));
		}
	});

	it("refuses the better-sqlite3 fallback, which is not bundled", () => {
		process.env.CC_DEBRIEF_SQLITE = "better-sqlite3";
		try {
			expect(() => openDb()).toThrow("not bundled in this build");
		} finally {
			delete process.env.CC_DEBRIEF_SQLITE;
		}
	});

	it("binds undefined as NULL and booleans as integers", () => {
		const db = openDb();
		try {
			db.exec("CREATE TABLE x (a, b)");
			db.prepare("INSERT INTO x VALUES (?, ?)").run(undefined, true);
			expect(db.prepare("SELECT a, b FROM x").get()).toEqual({ a: null, b: 1 });
		} finally {
			db.close();
		}
	});

	it.skipIf(process.platform === "win32")("makes the DB and WAL 0600 after a write", () => {
		const db = seedDb();
		try {
			setMeta(db, "k", "v");
			for (const f of [dbPath(), `${dbPath()}-wal`]) expect(statSync(f).mode & 0o777).toBe(0o600);
		} finally {
			db.close();
		}
	});

	it("prints no ExperimentalWarning when a process opens a DB", () => {
		ensureDir(t.home);
		const script = bundleScript(
			t.home,
			`import { openDb } from "./src/db/adapter.ts";
			const db = openDb(process.argv[2]); db.exec("CREATE TABLE x (a)"); db.close();`,
		);
		const r = spawnSync(process.execPath, [script, join(t.home, "child.db")], { encoding: "utf8" });
		expect(r.stderr).toBe("");
		expect(r.status).toBe(0);
		// Control: loading node:sqlite directly does warn, so an empty stderr above means something.
		const control = spawnSync(process.execPath, ["-e", 'process.getBuiltinModule("node:sqlite")'], {
			encoding: "utf8",
		});
		expect(control.stderr).toContain("ExperimentalWarning");
	});
});

describe("transaction", () => {
	it("commits on return and rolls back on throw", () => {
		const db = openDb();
		try {
			db.exec("CREATE TABLE x (a)");
			expect(db.transaction(() => db.prepare("INSERT INTO x VALUES (1)").run().changes)).toBe(1);
			expect(() =>
				db.transaction(() => {
					db.prepare("INSERT INTO x VALUES (2)").run();
					throw new Error("boom");
				}),
			).toThrow("boom");
			expect(db.prepare("SELECT a FROM x").all()).toEqual([{ a: 1 }]);
		} finally {
			db.close();
		}
	});

	it("nests with savepoints: an inner failure rolls back only the inner work", () => {
		const db = openDb();
		try {
			db.exec("CREATE TABLE x (a)");
			db.transaction(() => {
				db.prepare("INSERT INTO x VALUES (1)").run();
				expect(() =>
					db.transaction(() => {
						db.prepare("INSERT INTO x VALUES (2)").run();
						throw new Error("inner");
					}),
				).toThrow("inner");
			});
			expect(db.prepare("SELECT a FROM x").all()).toEqual([{ a: 1 }]);
		} finally {
			db.close();
		}
	});
});

describe("migrate and schema 001", () => {
	it("is a no-op the second time and records the latest schema_version", () => {
		const db = seedDb();
		try {
			expect(getMeta(db, "schema_version")).toBe("9");
			migrate(db);
			expect(getMeta(db, "schema_version")).toBe("9");
		} finally {
			db.close();
		}
	});

	it("gives every table an agent column defaulting to claude-code", () => {
		const db = seedDb();
		try {
			const tables = db
				.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
				.all<{ name: string }>()
				.map((r) => r.name);
			expect(tables).toEqual([
				"ai_calls",
				"compactions",
				"events",
				"file_changes",
				"findings",
				"instructions_loaded",
				"inventory",
				"inventory_usage",
				"meta",
				"patterns",
				"repos",
				"reviews",
				"rule_feedback",
				"self_usage",
				"sessions",
				"subagents",
				"tool_calls",
				"transcript_lines",
				"transcripts",
				"turns",
				"usage",
			]);
			for (const table of tables) {
				const agent = db
					.prepare(`PRAGMA table_info(${table})`)
					.all<{ name: string; dflt_value: string; notnull: number }>()
					.find((c) => c.name === "agent");
				expect(agent, table).toMatchObject({ dflt_value: "'claude-code'", notnull: 1 });
			}
		} finally {
			db.close();
		}
	});

	it("dedupes usage on (message_id, request_id) but never on a NULL message_id", () => {
		const db = seedDb();
		try {
			db.prepare("INSERT INTO sessions (session_id) VALUES ('s1')").run();
			const ins = db.prepare("INSERT INTO usage (session_id, message_id, request_id) VALUES ('s1', ?, ?)");
			ins.run("m1", "r1");
			expect(() => ins.run("m1", "r1")).toThrow(/UNIQUE/);
			ins.run("m1", "r2");
			ins.run("m2", null);
			expect(() => ins.run("m2", null)).toThrow(/UNIQUE/);
			ins.run(null, null);
			ins.run(null, null);
			expect(db.prepare("SELECT count(*) AS n FROM usage").get()).toEqual({ n: 5 });
		} finally {
			db.close();
		}
	});

	it("enforces foreign keys and the capture check", () => {
		const db = seedDb();
		try {
			expect(() => db.prepare("INSERT INTO turns (session_id, seq) VALUES ('nope', 1)").run()).toThrow(/FOREIGN KEY/);
			expect(() => db.prepare("INSERT INTO sessions (session_id, capture) VALUES ('s', 'x')").run()).toThrow(/CHECK/);
		} finally {
			db.close();
		}
	});
});

describe("meta", () => {
	it("gets null for a missing key and upserts values", () => {
		const db = seedDb();
		try {
			expect(getMeta(db, "k")).toBeNull();
			setMeta(db, "k", "a");
			setMeta(db, "k", "b");
			expect(getMeta(db, "k")).toBe("b");
		} finally {
			db.close();
		}
	});
});

describe("seedDb", () => {
	it("opens the DB named by an explicit env", () => {
		const path = join(t.home, "other.db");
		const db = seedDb({ ...t.env, CC_DEBRIEF_DB: path });
		db.close();
		expect(existsSync(path)).toBe(true);
	});
});

// The only module that touches node:sqlite. Everything else sees Db and Stmt.
import { chmodSync, existsSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync, SQLInputValue, StatementSync } from "node:sqlite";
import { dbPath, ensureDir } from "../paths";

export interface Stmt {
	run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
	get<T = unknown>(...params: unknown[]): T | undefined;
	all<T = unknown>(...params: unknown[]): T[];
}

export interface Db {
	exec(sql: string): void;
	prepare(sql: string): Stmt;
	/** Runs fn in a transaction (a savepoint when nested); commits on return, rolls back on throw. fn is sync. */
	transaction<T>(fn: () => T): T;
	close(): void;
}

type Sqlite = typeof import("node:sqlite");
let sqlite: Sqlite | undefined;

// node:sqlite emits an ExperimentalWarning when first loaded. Load it lazily with that one warning filtered, so
// neither the hook nor the CLI ever prints it (other warnings pass through).
function loadSqlite(): Sqlite {
	if (sqlite) return sqlite;
	const emit = process.emitWarning;
	process.emitWarning = function (this: unknown, warning: string | Error, ...rest: unknown[]) {
		const type = typeof rest[0] === "string" ? rest[0] : (rest[0] as { type?: string } | undefined)?.type;
		if (type === "ExperimentalWarning" || (warning instanceof Error && warning.name === "ExperimentalWarning")) return;
		return (emit as (...a: unknown[]) => void).call(process, warning, ...rest);
	} as typeof process.emitWarning;
	try {
		sqlite = process.getBuiltinModule("node:sqlite");
		return sqlite;
	} finally {
		process.emitWarning = emit;
	}
}

// node:sqlite cannot bind undefined or booleans.
const bindable = (v: unknown): unknown => (v === undefined ? null : typeof v === "boolean" ? Number(v) : v);
function bindAll(params: unknown[]): SQLInputValue[] {
	return params.map((p) =>
		p !== null && typeof p === "object" && !ArrayBuffer.isView(p)
			? Object.fromEntries(Object.entries(p).map(([k, v]) => [k, bindable(v)]))
			: bindable(p),
	) as SQLInputValue[];
}

function wrapStmt(s: StatementSync): Stmt {
	return {
		run: (...params) => {
			const r = s.run(...bindAll(params));
			return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
		},
		get: <T>(...params: unknown[]) => s.get(...bindAll(params)) as T | undefined,
		all: <T>(...params: unknown[]) => s.all(...bindAll(params)) as T[],
	};
}

function restrictModes(path: string): void {
	if (process.platform === "win32") return;
	for (const f of [path, `${path}-wal`, `${path}-shm`]) {
		try {
			chmodSync(f, 0o600);
		} catch {
			// not created yet
		}
	}
}

export function openDb(path: string = dbPath()): Db {
	const backend = process.env.CC_DEBRIEF_SQLITE;
	if (backend === "better-sqlite3") throw new Error("CC_DEBRIEF_SQLITE=better-sqlite3 is not bundled in this build");
	if (backend && backend !== "node") throw new Error(`unknown CC_DEBRIEF_SQLITE value: ${backend}`);

	const memory = path === ":memory:";
	const fresh = memory || !existsSync(path) || statSync(path).size === 0;
	if (!memory) {
		ensureDir(dirname(path));
		// Created 0600 up front: SQLite gives -wal and -shm the database file's mode.
		if (fresh) writeFileSync(path, "", { flag: "a", mode: 0o600 });
	}

	const { DatabaseSync } = loadSqlite();
	const raw: DatabaseSync = new DatabaseSync(path);
	// busy_timeout first: switching to WAL needs a lock, and another process may be opening or closing the file.
	raw.exec("PRAGMA busy_timeout = 2000");
	// page_size only takes effect before the first table exists (Phase 0 D1); existing files keep theirs.
	if (fresh) raw.exec("PRAGMA page_size = 8192");
	raw.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
	if (!memory) restrictModes(path);

	let depth = 0;
	return {
		exec: (sql) => raw.exec(sql),
		prepare: (sql) => wrapStmt(raw.prepare(sql)),
		transaction<T>(fn: () => T): T {
			const sp = `sp${depth}`;
			raw.exec(depth === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${sp}`);
			depth++;
			try {
				const result = fn();
				if (result instanceof Promise) throw new Error("db.transaction() needs a synchronous function");
				depth--;
				raw.exec(depth === 0 ? "COMMIT" : `RELEASE ${sp}`);
				return result;
			} catch (e) {
				depth--;
				raw.exec(depth === 0 ? "ROLLBACK" : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
				throw e;
			}
		},
		close: () => {
			raw.close();
			if (!memory) restrictModes(path);
		},
	};
}

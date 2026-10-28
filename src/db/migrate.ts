import type { Db } from "./adapter";
import init001 from "./migrations/001_init.sql";
import inventory002 from "./migrations/002_inventory.sql";
import selfUsage003 from "./migrations/003_self_usage.sql";
import findings004 from "./migrations/004_findings.sql";
import removeRules005 from "./migrations/005_remove_rules.sql";
import findingDates006 from "./migrations/006_finding_dates.sql";
import reviews007 from "./migrations/007_reviews.sql";
import patterns008 from "./migrations/008_patterns.sql";
import inventoryKinds009 from "./migrations/009_inventory_kinds.sql";
import { getMeta, setMeta } from "./queries/meta";

// Ordered; a migration's version is its NNN prefix. foreignKeysOff: a table rebuild (SQLite's 12-step ALTER), run
// with foreign keys off so dropping the old table cascades nothing, and checked before commit.
const MIGRATIONS: { version: number; sql: string; foreignKeysOff?: boolean }[] = [
	{ version: 1, sql: init001 },
	{ version: 2, sql: inventory002 },
	{ version: 3, sql: selfUsage003 },
	{ version: 4, sql: findings004 },
	{ version: 5, sql: removeRules005 },
	{ version: 6, sql: findingDates006 },
	{ version: 7, sql: reviews007 },
	{ version: 8, sql: patterns008 },
	{ version: 9, sql: inventoryKinds009, foreignKeysOff: true },
];

/** Applies every migration above meta.schema_version (up to `to`, for tests), each in its own transaction. */
export function migrate(db: Db, opts: { to?: number } = {}): void {
	const hasMeta = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get() !== undefined;
	const current = hasMeta ? Number(getMeta(db, "schema_version") ?? 0) : 0;
	for (const m of MIGRATIONS) {
		if (m.version <= current || m.version > (opts.to ?? Number.POSITIVE_INFINITY)) continue;
		// PRAGMA foreign_keys is a no-op inside a transaction, so it is set around it.
		if (m.foreignKeysOff) db.exec("PRAGMA foreign_keys = OFF");
		try {
			db.transaction(() => {
				db.exec(m.sql);
				if (m.foreignKeysOff && db.prepare("PRAGMA foreign_key_check").all().length > 0)
					throw new Error(`migration ${m.version} left rows that break a foreign key`);
				setMeta(db, "schema_version", String(m.version));
			});
		} finally {
			if (m.foreignKeysOff) db.exec("PRAGMA foreign_keys = ON");
		}
	}
}

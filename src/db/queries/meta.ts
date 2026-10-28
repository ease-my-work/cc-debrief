import type { Db } from "../adapter";

export function getMeta(db: Db, key: string): string | null {
	return db.prepare("SELECT value FROM meta WHERE key = ?").get<{ value: string }>(key)?.value ?? null;
}

export function setMeta(db: Db, key: string, value: string): void {
	db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(
		key,
		value,
	);
}

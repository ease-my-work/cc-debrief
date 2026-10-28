import { existsSync, readFileSync, rmSync } from "node:fs";
import type { Command } from "commander";
import { HOOK_MARKER, readSettingsBytes, removeHooks, replaceFile, SettingsError, sha256 } from "../claude/settings";
import { type Db, openDb } from "../db/adapter";
import { migrate } from "../db/migrate";
import { getMeta } from "../db/queries/meta";
import { binDir, claudeSettingsPath, dataDir, dbPath } from "../paths";
import { count, type Out, stdout, tilde } from "./common";

const META_KEYS = ["init.backup_path", "init.before_sha256", "init.after_sha256", "init.created"];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

// How many tracker hooks the file holds; refuses a file that is not valid JSON (exit 3, nothing written).
function trackerHookCount(path: string, bytes: Buffer): number {
	let value: unknown;
	try {
		value = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, ""));
	} catch {
		throw new SettingsError(`${path} is not valid JSON; fix it (or remove the cc-debrief hooks by hand) and run again`);
	}
	const hooks = isObj(value) && isObj(value.hooks) ? value.hooks : {};
	let n = 0;
	for (const groups of Object.values(hooks)) {
		if (!Array.isArray(groups)) continue;
		for (const g of groups) {
			if (!isObj(g) || !Array.isArray(g.hooks)) continue;
			for (const h of g.hooks) if (isObj(h) && typeof h.command === "string" && h.command.includes(HOOK_MARKER)) n++;
		}
	}
	return n;
}

/** cc-debrief uninit (feature 13): byte-identical restore when possible, else structural removal; drops bin/. */
export function runUninit(opts: { out?: Out } = {}): void {
	const out = opts.out ?? stdout;
	const path = claudeSettingsPath();
	const bytes = readSettingsBytes(path);
	const found = bytes ? trackerHookCount(path, bytes) : 0;
	// uninit never creates a DB: without one there is no init record and only the structural path runs.
	const db: Db | null = existsSync(dbPath()) ? openDb() : null;
	try {
		if (db) migrate(db);
		const meta = (key: string) => (db ? getMeta(db, key) : null);
		const created: string[] | undefined = meta("init.created") ? JSON.parse(meta("init.created") as string) : undefined;

		let how: string | null = null;
		if (bytes) {
			const after = meta("init.after_sha256");
			const backup = meta("init.backup_path");
			const before = meta("init.before_sha256");
			if (after && sha256(bytes) === after && created?.includes("<file>")) {
				rmSync(path);
				how = "deleted the file, which init created";
			} else if (after && sha256(bytes) === after && backup && before && existsSync(backup)) {
				const original = readFileSync(backup);
				if (sha256(original) === before) {
					replaceFile(path, original);
					how = "restored original bytes";
				}
			}
			if (!how && found > 0) {
				removeHooks(path, { created });
				how = "other changes kept";
			}
		}
		rmSync(binDir(), { recursive: true, force: true });
		if (db) db.prepare(`DELETE FROM meta WHERE key IN (${META_KEYS.map(() => "?").join(",")})`).run(...META_KEYS);

		if (!bytes || !how) out(`nothing to remove: no cc-debrief hooks in ${tilde(path)}`);
		else out(`Removed ${count(found, "hook")} from ${tilde(path)} (${how})`);
		out(`Your data is kept in ${tilde(dataDir())}. To delete it, delete that directory.`);
	} finally {
		db?.close();
	}
}

export function registerUninitCommand(program: Command): void {
	program
		.command("uninit")
		.description("remove the Claude Code hooks (settings.json restored); keeps your data")
		.action(() => runUninit());
}

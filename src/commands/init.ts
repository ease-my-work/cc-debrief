import { copyFileSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import { HOOK_MARKER, hookCommand, type InstallResult, installHooks, readSettingsBytes } from "../claude/settings";
import { loadConfig } from "../config";
import type { Db } from "../db/adapter";
import { getMeta, setMeta } from "../db/queries/meta";
import { localDate } from "../db/queries/range";
import { scanUserInto } from "../derive/inventory-usage";
import { listTranscripts, type TranscriptFile } from "../ingest/files";
import { ingestFiles, markMissingFiles } from "../ingest/ingest";
import { withSessionLock } from "../locks";
import { binDir, claudeSettingsPath, configPath, dataDir, dbPath, ensureDir } from "../paths";
import { VERSION } from "../version";
import { count, type Out, stdout, tilde, withDb } from "./common";
import { inventoryLine } from "./scan";

const label = (name: string) => name.padEnd(14);
const sub = (name: string) => `  ${name.padEnd(12)}`;

// meta init.* (architecture: src/commands): keep the first record while only our own writes happened since.
function recordInitMeta(db: Db, res: InstallResult, before: Buffer | null): void {
	const prevAfter = getMeta(db, "init.after_sha256");
	db.transaction(() => {
		if (prevAfter && res.beforeSha === prevAfter) {
			const created = new Set<string>(JSON.parse(getMeta(db, "init.created") ?? "[]"));
			for (const c of res.created) created.add(c);
			setMeta(db, "init.after_sha256", res.afterSha);
			setMeta(db, "init.created", JSON.stringify([...created]));
			return;
		}
		// Bytes that already hold tracker entries are no original to restore (an install whose record was lost).
		const clean = !before?.toString("utf8").includes(HOOK_MARKER);
		setMeta(db, "init.backup_path", res.backupPath ?? "");
		setMeta(db, "init.before_sha256", clean ? (res.beforeSha ?? "") : "");
		setMeta(db, "init.after_sha256", res.afterSha);
		setMeta(db, "init.created", JSON.stringify(res.created));
	});
}

function hookList(events: string[]): string {
	if (events.length === 0) return "";
	return `: ${events.map((e) => (e === "Stop" ? "Stop (async)" : e)).join(", ")}`;
}

async function backfill(db: Db, out: Out, tty: boolean): Promise<string> {
	const started = Date.now();
	const files = listTranscripts();
	const bySession = new Map<string, TranscriptFile[]>();
	for (const f of files) bySession.set(f.sessionId, [...(bySession.get(f.sessionId) ?? []), f]);
	const config = loadConfig();
	const imported = new Set<string>();
	let bytes = 0;
	let done = 0;
	const total = bySession.size;
	const step = Math.max(1, Math.ceil(total / 10));
	for (const [sessionId, group] of bySession) {
		// A live session's Stop worker may hold the lock; it reads those lines itself.
		const r = await withSessionLock(sessionId, { waitMs: 0 }, async () => ingestFiles(db, group, { config }));
		if (r !== "busy" && r.files > 0) {
			for (const s of r.sessions) imported.add(s);
			bytes += group.reduce((n, f) => n + f.size, 0);
		}
		done++;
		if (tty) process.stdout.write(`\rimporting ${done}/${total} sessions`);
		else if (total >= 100 && done % step === 0 && done < total) out(`importing ${done}/${total} sessions`);
	}
	if (tty && total > 0) process.stdout.write("\r\x1b[K");
	markMissingFiles(db, new Set(files.map((f) => f.path)));

	const ids = [...imported];
	let days = 0;
	if (ids.length > 0) {
		const span = db
			.prepare(
				`SELECT min(started_at) AS a, max(coalesce(ended_at, started_at)) AS b FROM sessions
				 WHERE session_id IN (${ids.map(() => "?").join(",")})`,
			)
			.get<{ a: string | null; b: string | null }>(...ids);
		if (span?.a && span.b) days = Math.max(1, Math.ceil((Date.parse(span.b) - Date.parse(span.a)) / 86_400_000));
	}
	const secs = (Date.now() - started) / 1000;
	const mb = (bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0);
	return `imported ${count(ids.length, "session")} (${count(days, "day")}, ${mb} MB of transcripts) in ${secs.toFixed(secs < 10 ? 1 : 0)} s · no AI used`;
}

/** cc-debrief init (feature 13): data dir, DB, bin/ copy, settings.json hooks, then the history backfill. */
export async function runInit(opts: { backfill: boolean; packageDir?: string; out?: Out; tty?: boolean }) {
	const out = opts.out ?? stdout;
	const tty = opts.tty ?? process.stdout.isTTY === true;
	const createdData = !existsSync(dataDir());
	ensureDir(dataDir());
	await withDb(async (db) => {
		if (!existsSync(configPath())) writeFileSync(configPath(), "{}\n", { mode: 0o600 });

		// The package may live in a cache npm cleans later (npx), so the hook runs from a copy.
		const pkgDir = opts.packageDir ?? dirname(fileURLToPath(import.meta.url));
		ensureDir(binDir());
		for (const f of ["hook.js", "cli.js"]) {
			const src = join(pkgDir, f);
			const dest = join(binDir(), f);
			if (!existsSync(src)) throw new Error(`${src} not found; run init from the installed cc-debrief package`);
			if (resolve(src) !== resolve(dest)) copyFileSync(src, dest);
		}
		writeFileSync(join(binDir(), "version"), `${VERSION}\n`);

		const settingsPath = claudeSettingsPath();
		const before = readSettingsBytes(settingsPath);
		const hookJs = join(binDir(), "hook.js");
		const res = installHooks(settingsPath, hookCommand(hookJs), {
			permissionHook: loadConfig().capture.permissionHook,
		});
		if (res.changed) recordInitMeta(db, res, before);

		out(`${label("Data dir")}${tilde(dataDir())}${createdData ? " (created)" : ""}`);
		out(`${label("Database")}${tilde(dbPath())} (schema v${getMeta(db, "schema_version")})`);
		out(`${label("Hook")}${tilde(hookJs)} (v${VERSION} copied)`);
		out(`${label("Settings")}${tilde(settingsPath)}${res.created.includes("<file>") ? " (created)" : ""}`);
		if (res.backupPath) out(`${sub("backup")}${tilde(res.backupPath)}`);
		const added = [...res.added, ...res.replaced];
		out(`${sub("added")}${count(added.length, "hook")}${hookList(added)}`);
		if (res.staleRemoved.length > 0) {
			out(`${sub("removed")}${count(res.staleRemoved.length, "hook")}${hookList(res.staleRemoved)} (not subscribed)`);
		}
		out(`${sub("skipped")}${res.skipped.length} (already present)`);
		// Before the backfill, so imported sessions join the inventory as they are derived.
		out(`${label("Inventory")}${inventoryLine(scanUserInto(db))}`);
		out(`${label("History")}${opts.backfill ? await backfill(db, out, tty) : "not imported (--no-backfill)"}`);
		for (const line of aiNotice(db)) out(line);
		out("Next: run `cc-debrief doctor` to check the install.");
	});
}

/** Feature 13: summaries spend plan usage, so init says so and prints the off switch; imported sessions need a
 * deliberate `enrich --ai --since`. */
function aiNotice(db: Db, now: Date = new Date()): string[] {
	const cfg = loadConfig();
	const lines = cfg.ai.summaries.enabled
		? [
				"AI summaries are ON for new sessions: each finished session makes one `claude -p` call",
				`on your plan (max ${cfg.ai.maxPerDay}/day). Turn off: cc-debrief config set ai.summaries.enabled false`,
			]
		: ["AI summaries are OFF. Turn on: cc-debrief config set ai.summaries.enabled true"];
	const imported = db.prepare("SELECT 1 AS x FROM sessions WHERE capture = 'backfill' LIMIT 1").get() !== undefined;
	if (cfg.ai.summaries.enabled && imported) {
		const since = localDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30));
		lines.push(`Imported sessions are not summarized. To summarize some: cc-debrief enrich --ai --since ${since}`);
	}
	return lines;
}

export function registerInitCommand(program: Command): void {
	program
		.command("init")
		.description("install the Claude Code hooks and import existing transcripts")
		.option("--no-backfill", "do not import existing transcripts now")
		.action(async (opts: { backfill: boolean }) => {
			await runInit({ backfill: opts.backfill });
		});
}

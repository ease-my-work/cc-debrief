// Inventory scan (feature 05): installed skills, plugins, MCP servers and hooks at user, plugin and repo level.
// Read-only on disk: nothing here writes outside the DB. MCP env values and headers are never kept.
import { closeSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";
import matter from "gray-matter";
import { HOOK_MARKER } from "../claude/settings";
import type { Db } from "../db/adapter";
import { setMeta } from "../db/queries/meta";
import { claudeDir, claudeJsonPath, claudeSettingsPath } from "../paths";

export type InventoryItem = {
	scope: "user" | "repo" | "plugin";
	repoId: string | null;
	kind: "skill" | "plugin" | "mcp" | "hook" | WorkspaceKind;
	name: string;
	path: string;
	description: string | null;
	meta: Record<string, unknown>;
};

type Obj = Record<string, unknown>;

/** Context cost of a skill's description: ceil(chars / 4). */
export function estimateContextTokens(description: string | null): number {
	return description ? Math.ceil(description.length / 4) : 0;
}

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function readJson(path: string): Obj | null {
	try {
		const v: unknown = JSON.parse(readFileSync(path, "utf8"));
		return isObj(v) ? v : null;
	} catch {
		return null;
	}
}

/** Directory entries that are directories, following symlinks; [] when unreadable. */
function subdirs(dir: string): string[] {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	return names.filter((n) => {
		try {
			return statSync(join(dir, n)).isDirectory();
		} catch {
			return false;
		}
	});
}

// gray-matter evaluates `---js` / `---javascript` / `---coffee` front matter as code. A SKILL.md comes from any repo
// the user opens (the SessionStart worker scans it), so only plain `---` YAML is read, and the script engines are
// replaced with ones that refuse.
const refuse = () => {
	throw new Error("script front matter is not read");
};
const SAFE_ENGINES = { js: refuse, javascript: refuse, coffee: refuse, coffeescript: refuse, cson: refuse };

/** YAML front matter of a SKILL.md as data; throws on anything but a plain `---` block. */
export function frontMatter(text: string): Obj {
	const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
	if (!/^---[ \t]*\r?\n/.test(body)) {
		if (body.startsWith("---")) throw new Error("only YAML front matter is read");
		return {};
	}
	const data: unknown = matter(body, { engines: SAFE_ENGINES, language: "yaml" }).data;
	return isObj(data) ? data : {};
}

// Front matter sits at the top; reading only the head keeps a huge SKILL.md, or one linked to a device, from stalling
// a scan that runs in the SessionStart worker and at dashboard start.
const SKILL_MD_MAX_BYTES = 64 * 1024;

/** The first SKILL_MD_MAX_BYTES of a regular file (symlinks followed); throws for anything else. */
function readHead(path: string): string {
	if (!statSync(path).isFile()) throw new Error("not a regular file");
	const fd = openSync(path, "r");
	try {
		const buf = Buffer.alloc(SKILL_MD_MAX_BYTES);
		const n = readSync(fd, buf, 0, buf.length, 0);
		return buf.subarray(0, n).toString("utf8");
	} finally {
		closeSync(fd);
	}
}

/** Skills in <dir>/*\/SKILL.md; name from frontmatter, else the directory name (parseError on bad frontmatter). */
function readSkills(dir: string): { name: string; path: string; description: string | null; parseError: boolean }[] {
	const out = [];
	for (const d of subdirs(dir).sort()) {
		const path = join(dir, d);
		let text: string;
		try {
			text = readHead(join(path, "SKILL.md"));
		} catch {
			continue;
		}
		let data: Obj = {};
		let parseError = false;
		try {
			data = frontMatter(text);
		} catch {
			parseError = true;
		}
		const name = typeof data.name === "string" && data.name.trim() ? data.name.trim() : d;
		const description =
			typeof data.description === "string" && data.description.trim() ? data.description.trim() : null;
		out.push({ name, path, description, parseError });
	}
	return out;
}

// ---- Workspace kinds (Phase 7 P11): agents, commands, output styles, rules, workflows ----

export type WorkspaceKind = "agent" | "command" | "output_style" | "rule" | "workflow";
/**
 * The .claude/ subfolder of each kind; nested folders name commands "a:b" and rules "a/b". Agents and output styles
 * take their front matter name; commands and rules are named by their path, as Claude Code runs them (/sc:implement).
 */
const WORKSPACE: { kind: WorkspaceKind; dir: string; markdown: boolean; nested: string | null; named: boolean }[] = [
	{ kind: "agent", dir: "agents", markdown: true, nested: null, named: true },
	{ kind: "command", dir: "commands", markdown: true, nested: ":", named: false },
	{ kind: "output_style", dir: "output-styles", markdown: true, nested: null, named: true },
	{ kind: "rule", dir: "rules", markdown: true, nested: "/", named: false },
	{ kind: "workflow", dir: "workflows", markdown: false, nested: null, named: false },
];
/** The .claude/ subfolder a workspace kind lives in (for source labels). */
export const workspaceDir = (kind: string): string | null => WORKSPACE.find((w) => w.kind === kind)?.dir ?? null;
const WORKSPACE_MAX_DEPTH = 4;
const WORKSPACE_MAX_FILES = 500;

/** Regular files under dir (depth-limited, sorted), as paths. */
function filesUnder(dir: string, depth: number, out: string[]): void {
	if (depth > WORKSPACE_MAX_DEPTH || out.length >= WORKSPACE_MAX_FILES) return;
	let names: string[];
	try {
		names = readdirSync(dir).sort();
	} catch {
		return;
	}
	for (const n of names) {
		const p = join(dir, n);
		try {
			const s = statSync(p);
			if (s.isFile()) {
				if (out.length < WORKSPACE_MAX_FILES) out.push(p);
			} else if (s.isDirectory()) filesUnder(p, depth + 1, out);
		} catch {
			// unreadable entry
		}
	}
}

/** The workspace items in one .claude/ folder: name from front matter, else the file path (no extension). */
function readWorkspace(
	claudeRoot: string,
): { kind: WorkspaceKind; name: string; path: string; description: string | null }[] {
	const out = [];
	for (const w of WORKSPACE) {
		const base = join(claudeRoot, w.dir);
		const files: string[] = [];
		filesUnder(base, w.nested ? 0 : WORKSPACE_MAX_DEPTH, files);
		for (const path of files) {
			if (w.markdown && extname(path).toLowerCase() !== ".md") continue;
			let data: Obj = {};
			if (extname(path).toLowerCase() === ".md") {
				try {
					data = frontMatter(readHead(path));
				} catch {
					data = {};
				}
			}
			const rel = relative(base, path).replaceAll("\\", "/");
			const stem = rel.slice(0, rel.length - extname(rel).length);
			const fallback = w.nested ? stem.split("/").join(w.nested) : basename(stem);
			const name = w.named && typeof data.name === "string" && data.name.trim() ? data.name.trim() : fallback;
			const description =
				typeof data.description === "string" && data.description.trim() ? data.description.trim() : null;
			out.push({ kind: w.kind, name, path, description });
		}
	}
	return out;
}

/** Transport and target only: type, command + args (stdio) or url (http/sse). Never env or headers. */
function mcpMeta(entry: unknown): Obj {
	const e = isObj(entry) ? entry : {};
	const type = typeof e.type === "string" ? e.type : typeof e.url === "string" ? "http" : "stdio";
	if (type === "stdio") {
		const meta: Obj = { type };
		if (typeof e.command === "string") meta.command = e.command;
		if (Array.isArray(e.args)) meta.args = e.args.filter((a) => typeof a === "string");
		return meta;
	}
	return typeof e.url === "string" ? { type, url: e.url } : { type };
}

/** Server map from a config object: `{ mcpServers: {...} }` or the bare map. */
function serverMap(config: Obj | null): Obj {
	if (!config) return {};
	return isObj(config.mcpServers) ? config.mcpServers : config;
}

function mcpItems(servers: Obj, base: Omit<InventoryItem, "name" | "meta" | "kind" | "description">, extra: Obj = {}) {
	return Object.entries(servers)
		.filter(([, entry]) => isObj(entry))
		.map(
			([name, entry]): InventoryItem => ({
				...base,
				kind: "mcp",
				name,
				description: null,
				meta: { ...mcpMeta(entry), ...extra },
			}),
		);
}

/** One item per event + command in a settings `hooks` object; entries carrying our marker are left out. */
function hookItems(settings: Obj | null, path: string, scope: "user" | "repo", repoId: string | null): InventoryItem[] {
	const hooks = settings && isObj(settings.hooks) ? settings.hooks : {};
	const out: InventoryItem[] = [];
	for (const [event, groups] of Object.entries(hooks)) {
		if (!Array.isArray(groups)) continue;
		for (const group of groups) {
			if (!isObj(group) || !Array.isArray(group.hooks)) continue;
			const matcher = typeof group.matcher === "string" && group.matcher ? group.matcher : null;
			for (const h of group.hooks) {
				if (!isObj(h)) continue;
				const command = typeof h.command === "string" ? h.command : typeof h.prompt === "string" ? h.prompt : null;
				if (!command || command.includes(HOOK_MARKER)) continue;
				out.push({
					scope,
					repoId,
					kind: "hook",
					name: `${event}${matcher ? `[${matcher}]` : ""}: ${command}`,
					path,
					description: null,
					meta: { event, matcher, type: typeof h.type === "string" ? h.type : "command", command },
				});
			}
		}
	}
	return out;
}

/** enabledPlugins entries of a settings file as plugin items (repo settings: scope repo). */
function enabledPluginItems(settings: Obj | null, path: string, repoId: string): InventoryItem[] {
	const enabled = settings && isObj(settings.enabledPlugins) ? settings.enabledPlugins : {};
	return Object.entries(enabled).map(([key, on]) => {
		const [name, marketplace = null] = key.split("@");
		return {
			scope: "repo",
			repoId,
			kind: "plugin",
			name,
			path,
			description: null,
			meta: { key, marketplace, enabled: on === true },
		};
	});
}

const normPath = (p: string): string => {
	const r = resolve(p).replace(/[\\/]+$/, "");
	return process.platform === "win32" ? r.toLowerCase() : r;
};

/** User-level inventory under claudeDir(), plus ~/.claude.json MCP servers and installed plugins. */
export function scanUser(opts: { repos?: { repoId: string; rootPath: string }[] } = {}): InventoryItem[] {
	const items: InventoryItem[] = [];
	const settingsPath = claudeSettingsPath();
	const settings = readJson(settingsPath);

	for (const s of readSkills(join(claudeDir(), "skills"))) {
		items.push({
			scope: "user",
			repoId: null,
			kind: "skill",
			name: s.name,
			path: s.path,
			description: s.description,
			meta: s.parseError ? { parseError: true } : {},
		});
	}

	for (const w of readWorkspace(claudeDir()))
		items.push({
			scope: "user",
			repoId: null,
			kind: w.kind,
			name: w.name,
			path: w.path,
			description: w.description,
			meta: {},
		});

	// Plugins: one per installed_plugins.json key, read at its installPath (older versions in plugins/cache/ ignored).
	const installed = readJson(join(claudeDir(), "plugins", "installed_plugins.json"));
	const plugins = installed && isObj(installed.plugins) ? installed.plugins : {};
	const enabled = settings && isObj(settings.enabledPlugins) ? settings.enabledPlugins : null;
	const seen = new Set<string>();
	for (const [key, entries] of Object.entries(plugins)) {
		const list = Array.isArray(entries) ? entries.filter(isObj) : [];
		const entry = list.find((e) => e.scope === "user") ?? list[0];
		if (!entry || typeof entry.installPath !== "string") continue;
		const [plugin, marketplace = null] = key.split("@");
		if (seen.has(plugin)) continue;
		seen.add(plugin);
		const installPath = entry.installPath;
		const manifest =
			readJson(join(installPath, ".claude-plugin", "plugin.json")) ?? readJson(join(installPath, "plugin.json"));
		items.push({
			scope: "plugin",
			repoId: null,
			kind: "plugin",
			name: plugin,
			path: installPath,
			description: manifest && typeof manifest.description === "string" ? manifest.description : null,
			meta: {
				key,
				marketplace,
				version: typeof entry.version === "string" ? entry.version : null,
				enabled: enabled ? enabled[key] === true : null,
			},
		});
		for (const s of readSkills(join(installPath, "skills"))) {
			items.push({
				scope: "plugin",
				repoId: null,
				kind: "skill",
				name: `${plugin}:${s.name}`,
				path: s.path,
				description: s.description,
				meta: { plugin, ...(s.parseError ? { parseError: true } : {}) },
			});
		}
		for (const w of readWorkspace(installPath))
			items.push({
				scope: "plugin",
				repoId: null,
				kind: w.kind,
				name: `${plugin}:${w.name}`,
				path: w.path,
				description: w.description,
				meta: { plugin },
			});
		const mcpPath = join(installPath, ".mcp.json");
		const mcpConfig = readJson(mcpPath);
		const servers = mcpConfig
			? serverMap(mcpConfig)
			: manifest && isObj(manifest.mcpServers)
				? manifest.mcpServers
				: {};
		items.push(
			...mcpItems(servers, { scope: "plugin", repoId: null, path: mcpConfig ? mcpPath : installPath }, { plugin }),
		);
	}

	// ~/.claude.json: user servers, and project servers for paths that match a known repo root.
	const claudeJson = readJson(claudeJsonPath());
	if (claudeJson) {
		const path = claudeJsonPath();
		items.push(
			...mcpItems(isObj(claudeJson.mcpServers) ? claudeJson.mcpServers : {}, { scope: "user", repoId: null, path }),
		);
		const roots = new Map((opts.repos ?? []).map((r) => [normPath(r.rootPath), r.repoId]));
		const projects = isObj(claudeJson.projects) ? claudeJson.projects : {};
		for (const [projectPath, project] of Object.entries(projects)) {
			const repoId = roots.get(normPath(projectPath));
			if (!repoId || !isObj(project) || !isObj(project.mcpServers)) continue;
			items.push(...mcpItems(project.mcpServers, { scope: "repo", repoId, path }, { source: "claude.json" }));
		}
	}

	items.push(...hookItems(settings, settingsPath, "user", null));
	return items;
}

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "vendor", ".venv", ".claude"]);
const MAX_DEPTH = 6;
const MAX_DIRS = 10_000;

/** Repo-level inventory: startup and lazy skills, .mcp.json, and .claude/settings.json plugins and hooks. */
export function scanRepo(root: string, repoId: string): InventoryItem[] {
	try {
		if (!statSync(root).isDirectory()) return [];
	} catch {
		return [];
	}
	const items: InventoryItem[] = [];
	const skill = (s: ReturnType<typeof readSkills>[number], load: "startup" | "lazy"): InventoryItem => ({
		scope: "repo",
		repoId,
		kind: "skill",
		name: s.name,
		path: s.path,
		description: s.description,
		meta: { load, ...(s.parseError ? { parseError: true } : {}) },
	});
	for (const s of readSkills(join(root, ".claude", "skills"))) items.push(skill(s, "startup"));
	for (const w of readWorkspace(join(root, ".claude")))
		items.push({
			scope: "repo",
			repoId,
			kind: w.kind,
			name: w.name,
			path: w.path,
			description: w.description,
			meta: {},
		});

	// Breadth-first below the root; symlinked dirs are followed once (visited by real path).
	const visited = new Set<string>();
	const real = (p: string) => {
		try {
			return realpathSync(p);
		} catch {
			return null;
		}
	};
	visited.add(real(root) ?? root);
	let queue = [{ dir: root, depth: 0 }];
	let count = 0;
	while (queue.length && count < MAX_DIRS) {
		const next: typeof queue = [];
		for (const { dir, depth } of queue) {
			if (depth >= MAX_DEPTH) continue;
			for (const name of subdirs(dir).sort()) {
				if (SKIP_DIRS.has(name) || count >= MAX_DIRS) continue;
				const child = join(dir, name);
				const r = real(child);
				if (!r || visited.has(r)) continue;
				visited.add(r);
				count++;
				for (const s of readSkills(join(child, ".claude", "skills"))) items.push(skill(s, "lazy"));
				next.push({ dir: child, depth: depth + 1 });
			}
		}
		queue = next;
	}

	const mcpPath = join(root, ".mcp.json");
	items.push(...mcpItems(serverMap(readJson(mcpPath)), { scope: "repo", repoId, path: mcpPath }));

	const settingsPath = join(root, ".claude", "settings.json");
	const settings = readJson(settingsPath);
	items.push(...enabledPluginItems(settings, settingsPath, repoId));
	items.push(...hookItems(settings, settingsPath, "repo", repoId));
	return items;
}

const identity = (i: InventoryItem) => JSON.stringify([i.scope, i.repoId ?? "", i.kind, i.name]);

/**
 * Inserts new items (first_seen = last_seen = now) and updates known ones (path, description, meta, last_seen).
 * Items not passed keep their last_seen; meta last_scan_<scopeKey> = now marks them removed.
 */
export function upsertInventory(
	db: Db,
	items: InventoryItem[],
	scopeKey: string,
	now: Date = new Date(),
): { inserted: number; updated: number } {
	const ts = now.toISOString();
	const find = db.prepare(
		`SELECT id FROM inventory WHERE agent = 'claude-code' AND scope = ? AND COALESCE(repo_id, '') = ? AND kind = ? AND name = ?`,
	);
	const insert = db.prepare(
		`INSERT INTO inventory (scope, repo_id, kind, name, path, description, first_seen, last_seen, meta)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	const update = db.prepare("UPDATE inventory SET path = ?, description = ?, meta = ?, last_seen = ? WHERE id = ?");
	let inserted = 0;
	let updated = 0;
	db.transaction(() => {
		const done = new Set<string>();
		for (const i of items) {
			const key = identity(i);
			if (done.has(key)) continue; // first occurrence wins within one scan
			done.add(key);
			const meta = JSON.stringify(i.meta);
			const row = find.get<{ id: number }>(i.scope, i.repoId ?? "", i.kind, i.name);
			if (row) {
				update.run(i.path, i.description, meta, ts, row.id);
				updated++;
			} else {
				insert.run(i.scope, i.repoId, i.kind, i.name, i.path, i.description, ts, ts, meta);
				inserted++;
			}
		}
		setMeta(db, `last_scan_${scopeKey}`, ts);
	});
	return { inserted, updated };
}

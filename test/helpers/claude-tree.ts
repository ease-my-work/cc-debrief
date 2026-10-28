// Builds fake Claude config trees (~/.claude, ~/.claude.json, plugins) and repos on disk for inventory tests.
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

/** Writes each relative path under root; objects are written as JSON. */
export function writeTree(root: string, files: Record<string, string | object>): void {
	for (const [rel, content] of Object.entries(files)) {
		const path = join(root, rel);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content, null, 2));
	}
}

export const skillMd = (name: string | null, description: string | null): string =>
	`---\n${name ? `name: ${name}\n` : ""}${description ? `description: ${description}\n` : ""}---\n\n# ${name ?? "skill"}\n`;

export const BAD_FRONTMATTER = "---\nname: [unclosed\ndescription: : :\n---\nbody\n";

/** Adds one installed plugin: installed_plugins.json entry (merged), files under its installPath. */
export function addPlugin(
	claude: string,
	key: string,
	opts: { version?: string; files?: Record<string, string | object> } = {},
): string {
	const [name, marketplace] = key.split("@");
	const installPath = join(claude, "plugins", "cache", marketplace, name, opts.version ?? "1.0.0");
	writeTree(installPath, { ".claude-plugin/plugin.json": { name }, ...(opts.files ?? {}) });
	const listPath = join(claude, "plugins", "installed_plugins.json");
	let list: { version: number; plugins: Record<string, unknown[]> } = { version: 2, plugins: {} };
	try {
		list = JSON.parse(readFileSync(listPath, "utf8"));
	} catch {}
	list.plugins[key] = [{ scope: "user", installPath, version: opts.version ?? "1.0.0" }];
	writeTree(claude, { "plugins/installed_plugins.json": list });
	return installPath;
}

/**
 * The Task 2 user tree: 2 user skills (one with bad frontmatter), an enabled and a disabled plugin with one skill
 * each, 2 user MCP servers (stdio with env, http with headers) and 2 hook entries (one of ours).
 */
export function standardUserTree(claude: string): void {
	writeTree(claude, {
		"skills/code-review/SKILL.md": skillMd("code-review", "Review a diff for bugs"),
		"skills/broken/SKILL.md": BAD_FRONTMATTER,
		"skills/not-a-skill/README.md": "no SKILL.md here",
		"settings.json": {
			enabledPlugins: { "superpowers@mkt": true, "oldtool@mkt": false },
			hooks: {
				SessionStart: [{ hooks: [{ type: "command", command: 'node "/x/bin/hook.js" # cc-debrief' }] }],
				PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo checked" }] }],
			},
		},
		".claude.json": {
			mcpServers: {
				github: { type: "stdio", command: "npx", args: ["-y", "gh-mcp"], env: { TOKEN: "x-secret-token" } },
				linear: { type: "http", url: "https://mcp.example/mcp", headers: { Authorization: "Bearer x-secret-token" } },
			},
		},
	});
	addPlugin(claude, "superpowers@mkt", {
		files: { "skills/brainstorming/SKILL.md": skillMd("brainstorming", "Explore ideas") },
	});
	addPlugin(claude, "oldtool@mkt", { files: { "skills/thing/SKILL.md": skillMd("thing", "Does a thing") } });
}

/** sha256 over every file's relative path, size, mtime and content, and every directory's path, under root. */
export function treeHash(root: string): string {
	const h = createHash("sha256");
	const walk = (dir: string) => {
		for (const name of readdirSync(dir).sort()) {
			const path = join(dir, name);
			const st = statSync(path);
			h.update(`${relative(root, path)}|${st.isDirectory() ? "d" : "f"}|${st.size}|${st.mtimeMs}\n`);
			if (st.isDirectory()) walk(path);
			else h.update(readFileSync(path));
		}
	};
	walk(root);
	return h.digest("hex");
}

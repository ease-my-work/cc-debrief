# 05 — Inventory scan

**Code:** `src/collector/inventory.ts`, `src/derive/inventory-usage.ts`, `src/db/queries/inventory.ts`, `src/commands/scan.ts`

## Purpose
Installed skills, plugins and MCP servers load into every session and use context whether or not they are used.
The inventory scan reads what is installed at user level, in plugins and in each repo seen; derivation records
which items were loaded in each session and which were invoked; the dashboard estimates the context cost of the
unused ones. The scan is read-only: it never writes, deletes or opens anything outside the tracker's database.

## Behaviour

### Triggers
1. `cc-debrief init` runs a user-level scan before the backfill.
2. `cc-debrief scan [path]` rescans user level and, if `path` (default: the current directory) is inside a git repo, that repo.
3. `cc-debrief dashboard` scans user level and every repo that had a session in the last 30 days and whose root still exists, before serving.
4. The `snapshot` worker (on `SessionStart`) scans the session's repo, so its inventory reflects the state at session start. Backfilled sessions use the current state.

Every scan goes through `applyScan()`: upsert, then rebuild `inventory_usage` for the scope's sessions started in
the last 30 days.

### User-level scan (`scanUser()`)
All paths are under `claudeDir()` (honours `CLAUDE_CONFIG_DIR`), plus `~/.claude.json`.
- **Skills:** `skills/*/SKILL.md`; `name` and `description` from YAML front matter (only plain `---` YAML is read; script front matter is refused); scope `user`.
- **Plugins:** one item per key in `plugins/installed_plugins.json` (`<plugin>@<marketplace>`), read from its `installPath` (older versions under `plugins/cache/` are ignored); enabled state from `enabledPlugins` in `settings.json`. Each plugin's `skills/<name>/SKILL.md` becomes a `plugin`-scope skill named `<plugin>:<skill>` (the spelling Claude Code uses in listings and `Skill` calls), and its `.mcp.json` (or `mcpServers` in its manifest) gives `plugin`-scope MCP items with `meta.plugin`.
- **MCP servers:** `mcpServers` in `~/.claude.json` (scope `user`); `projects.<path>.mcpServers` for a path matching a known repo root become scope `repo` with `meta.source = "claude.json"`.
- **Hooks:** one item per event, matcher and command in `settings.json` `hooks`; the tracker's own entries (marked `# cc-debrief`) are excluded.
- **Agents, commands, output styles, rules, workflows:** `agents/*.md`, `commands/**/*.md`, `output-styles/*.md`, `rules/**/*.md`, `workflows/*`, in the user folder and in each plugin. Agents and output styles are named by front matter `name`, else the file name; commands and rules by their path as Claude Code runs them (`commands/sc/implement.md` is `sc:implement`). Walks stop at depth 4 and 500 files per folder.

### Repo-level scan (`scanRepo(root, repoId)`)
- **Skills:** `<root>/.claude/skills/*/SKILL.md` (`meta.load = "startup"`), and `<subdir>/.claude/skills/` below the root (`meta.load = "lazy"`, loaded only once Claude works in that subtree). The walk is breadth-first, skips `.git`, `node_modules`, `dist`, `build`, `vendor`, `.venv` and `.claude`, follows symlinks once (cycles cut by real path), and stops at depth 6 or 10,000 directories.
- **MCP servers:** `.mcp.json` at the root.
- **Plugins and hooks:** `.claude/settings.json` in the repo (`enabledPlugins` and `hooks`).
- **Agents, commands, output styles, rules, workflows:** under `<root>/.claude/`, as at user level.

For every MCP item, `meta` stores only the transport and target: `type` (`stdio` / `http` / `sse`), `command` +
`args` for stdio, `url` otherwise. Env values and headers are never stored. [07 — Session review,
Tier 1](07-session-review-tier1.md) uses `url` and `command`.

### Upsert
`upsertInventory(db, items, scopeKey)` (`scopeKey` = `user` or `repo:<repo_id>`) matches on (`agent`, `scope`,
`repo_id`, `kind`, `name`): new items get `first_seen = last_seen = now`, known ones get `path`, `description`,
`meta` and `last_seen` updated. It sets `meta` `last_scan_<scopeKey>`; an item whose `last_seen` is older than its
scope's last scan is shown as removed, and its history stays.

### Loaded and invoked (per session, `deriveInventoryUsage()`)
One `inventory_usage` row per item in effect for the session; anything invoked also counts as loaded.
- **Skills loaded:** every name in the session's `skill_listing` and `dynamic_skill` attachments (see [03](03-tool-mcp-skill-usage.md)), matched exactly: plugin skills arrive qualified (`example-plugin:hello`), user and repo skills bare. A listed name with no installed row creates one with `meta.source = "transcript"` (scope `repo` for a `dynamic_skill` name, `plugin` when the name has a `:`, else `user`).
- **Fallback without any `skill_listing`** (older Claude Code): user skills, enabled plugins' skills, startup repo skills, and lazy repo skills whose subtree holds the session's `cwd` or a path it read or edited.
- **MCP loaded:** user servers, the repo's servers (`.mcp.json` and `~/.claude.json` project entries) and enabled plugins' servers.
- **Agents and commands:** loaded when available (user, this repo, enabled plugins); an agent is invoked by a subagent of that `agent_type`, a command by its `<command-name>` slash command.
- **Invoked** skills and MCP servers: set from `Skill` calls, slash commands and MCP calls, as described in [03](03-tool-mcp-skill-usage.md).
- Plugins, hooks, output styles, rules and workflows get no usage rows; the dashboard shows the last three as "usage not recorded".

### Status and cost (API)
- `active`: invoked in the last 30 days. `unused_30d`: invoked before that only. `never_used`: never invoked.
- Context tokens per skill = `estimateContextTokens(description)` = `ceil(chars / 4)` (0 without a description). "Context cost" = the sum of that estimate over unused skills loaded per session.
- An MCP server's tool count = distinct `mcp_tool` values seen in `tool_calls` (tool schemas are not readable without starting the server). A called server with no inventory row (for example a claude.ai connector) is listed from `tool_calls` only, shown as "no config found" or as `claude.ai`.

## Data
| Table | Columns | Notes |
| --- | --- | --- |
| `inventory` | id, scope (`user` / `repo` / `plugin`), repo_id, kind (`skill`, `plugin`, `mcp`, `hook`, `agent`, `command`, `output_style`, `rule`, `workflow`), name, path, description, first_seen, last_seen, meta (JSON) | Unique on (`agent`, `scope`, `repo_id`, `kind`, `name`) |
| `inventory_usage` | inventory_id, session_id, loaded, invoked | Primary key (`inventory_id`, `session_id`) |
| `meta` | `last_scan_user`, `last_scan_repo:<repo_id>`, `skills:<session_id>` | Scan times; per-session skill signals |

Created by `002_inventory.sql`; `009_inventory_kinds.sql` adds the agent, command, output style, rule and workflow
kinds.

## Interfaces
- `src/collector/inventory.ts` → `scanUser(opts?: { repos? })`, `scanRepo(root, repoId)`, `upsertInventory(db, items, scopeKey, now?)`, `estimateContextTokens(description)`, `frontMatter()`; type `InventoryItem`.
- `src/derive/inventory-usage.ts` → `applyScan()`, `scanUserInto()`, `scanRepoInto()`, `deriveInventoryUsage()`, `deriveMissingInventoryUsage()`.
- `src/paths.ts` → `claudeDir()`, `claudeSettingsPath()`, `claudeJsonPath()`.
- API: `GET /api/inventory?kind=…`, `GET /api/tools`, `GET /api/repos/:id` (repo-level panel).
- CLI: `scan [path]`; `init` and `dashboard` scan as above.

## UI
- Skills & Tools view: tabs for skills, MCP servers, built-in tools, plugins and hooks, and the other kinds; a date range.
- Summary strip: installed (by scope), invoked in the range, never invoked, and context cost per session from unused skills.
- Skills table: skill (with plugin or path), scope, sessions loaded and invoked, invoked/loaded bar, last used, context tokens, status badge, and a "Remove" action that shows the item's path with a copy button (nothing is deleted or opened by the server). "Show unused only" toggle.
- Repo detail: repo-level skills (lazy ones labelled), MCP servers and hooks with usage badges, and how often CLAUDE.md was loaded (from `instructions_loaded`).
- Repos table: repo skills used / available and repo MCP columns.

## Edge cases and failure modes
- `SKILL.md` with invalid or missing front matter: `name` = directory name, `description = NULL`, `meta.parseError = true`. Only the first 64 KB of a `SKILL.md` is read.
- `~/.claude.json` or `settings.json` missing or invalid: the affected items are skipped; the scan continues.
- Same skill name at user and repo scope: two rows; a `Skill` call carries only the name, so both are marked invoked.
- The same MCP server as a plugin and as a claude.ai connector: one plugin row; the connector's calls do not mark it invoked, because `mcp_source` differs.
- Skill listed in a transcript but no longer on disk: its `transcript` row is kept and shown as removed. Transcript-only rows no session uses any more are deleted.
- A transcript-only row that a later scan finds becomes the scanned row in place (same id, history kept), but moves into a repo's scope only when it is that repo's own row or every session using it is in that repo.
- Repo root no longer exists: `dashboard` skips it; its items keep their last `last_seen`.
- Unreadable directories: skipped silently.
- Windows: repo paths in `~/.claude.json` `projects` are compared case-insensitively.

## Dependencies
- Depends on: [01 — Session capture](01-session-capture.md), [04 — Repo and file attribution](04-repo-file-attribution.md) (repo root and id), [13 — CLI](13-cli.md).
- Depended on by: [03](03-tool-mcp-skill-usage.md), [07](07-session-review-tier1.md), [09](09-weekly-coaching-digest.md), [11](11-skill-claudemd-suggestions.md), [12 — Dashboard](12-dashboard.md).

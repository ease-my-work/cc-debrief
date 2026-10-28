# 03 — Tool, MCP and skill usage

**Code:** `src/derive/tools.ts`, `src/derive/tool-categories.ts`, `src/derive/session.ts`, `src/derive/inventory-usage.ts`

## Purpose
Shows which tools, MCP servers and skills Claude actually uses, how long calls take and which ones fail. Each
`tool_use` block in the transcript and its matching `tool_result` become one `tool_calls` row with duration,
success and denial; MCP server/tool names and skill names are parsed at derive time. It also records which skills
were loaded into each session. No tool hooks are used. This feeds the session timeline, the Skills & Tools view
and most coaching signals.

## Behaviour
Runs inside `deriveSession()` over the session's `transcript_lines` (main and subagents).

1. Collect every `tool_use` block in `assistant` lines (`id`, `name`, `input`), deduplicated by `id` (first wins), with the line's timestamp and `agent_id`.
2. Pair each with the `tool_result` block of the same `tool_use_id` in a `user` line. Each pair is one `tool_calls` row:
   - `started_at` / `ended_at` = the `tool_use` / `tool_result` line timestamps. Duration includes time waiting on a permission prompt.
   - `denied` = the result line's `toolDenialKind` (`user-rejected`, `permission-rule`, `automode-blocked`, …), else `NULL`.
   - `ok` = 0 when the result has `is_error: true` or the call was denied, else 1. Failure counts exclude denied calls.
   - `exit_code` = N when a non-denied `Bash` or `PowerShell` result starts with `Exit code N`, else `NULL`. Output on stderr alone is not a failure.
   - `input` = the tool input; `response` = `{ toolUseResult, bytes, isError, excerpt, origBytes? }`: `toolUseResult` trimmed to `structuredPatch`, `filePath` and small scalar fields (a string result capped at 1 KB); `bytes` = byte length of the stored result text; `excerpt` = its first 4 KB; `origBytes` = the length before capping, when it was cut. Both columns are compressed with `encodePayload()`; the stored result itself stays in `transcript_lines`.
3. `parseToolName(name, input)`:
   - `mcp__<middle>__<tool>`: split after the prefix on the first `__`; `mcp_tool` = the right part. The middle part:
     - `plugin_<plugin>_<server>` (a plugin's server): `mcp_server` = `<server>`, `mcp_source` = `plugin:<plugin>` (plugin name = text up to the first `_`);
     - `claude_ai_<Name>` (a claude.ai connector): `mcp_server` = `<Name>`, `mcp_source` = `claude.ai`;
     - anything else (`~/.claude.json` or `.mcp.json`): `mcp_server` = the middle part, `mcp_source` = `NULL`.
     The line's `attributionMcpServer` / `attributionMcpTool`, when present, win.
   - `Skill`: `skill_name` = `input.skill`, else `input.skill_name`, else the first string field whose key ends in `skill`.
   - Anything else: all parsed fields `NULL`.
4. `turn_id` = the latest turn that started at or before the call. Subagent calls take the turn of the `Agent` / `Task` call that spawned the subagent.
5. **Skills invoked** = `Skill` calls plus slash commands: a `user` line holding `<command-name>/<name></command-name>` whose name matches a skill. Claude Code's built-in commands (`/model`, `/compact`, `/clear`, …) are ignored. A slash command creates no `tool_calls` row. `invoked_skills` attachments are not used: they appear only after compaction and restate every skill used so far.
6. **Skills loaded** = the union of all `skill_listing` attachments (the first, `isInitial: true`, is the full set; later ones are deltas, for example a skill in a subdirectory once Claude reads a file there) and `dynamic_skill` attachments (`skillNames[]`). Plugin skills are spelled `<plugin>:<skill>`, user and repo skills bare.
7. `inventory_usage` rows are rebuilt from these signals (see [05 — Inventory scan](05-inventory-scan.md)): a skill row is invoked when its name, or for a plugin skill its unqualified name, was invoked; an MCP row is invoked when a call's `mcp_server` matches its name case-insensitively and the source matches (plugin calls only match that plugin's servers, other calls only non-plugin servers, claude.ai calls nothing).
8. Permission prompts are not tool calls: they stay in `events` and are counted on demand by [07 — Session review, Tier 1](07-session-review-tier1.md).

### Aggregates (API, over the selected range)
- Built-in tools: calls, failures (`ok = 0 AND denied IS NULL`), denials, median duration per tool name where `mcp_server IS NULL`.
- MCP servers: per `mcp_server` and `mcp_source`: distinct tools, calls, failures, median duration.
- Skills: sessions loaded and invoked per skill, joined with the inventory.
- **Tool categories** (`toolCategory(name, mcpServer)`): file read, file edit, search, shell, web, agents, tasks and plans, skills, MCP (any call with an MCP server), other. The map is `src/derive/tool-categories.ts`; the tools table filters by category.
- **Feature adoption** (`GET /api/adoption`, share of sessions in range): plan mode (`permission_mode = 'plan'` or an `EnterPlanMode` call), subagents, skills, MCP, web tools, auto mode.
- **Claude Code versions** (`GET /api/versions`): `sessions.cc_version` with first seen, last seen and session count, newest version first.

## Data
| Table | Columns | Notes |
| --- | --- | --- |
| `tool_calls` | session_id, agent_id, turn_id, tool_use_id, tool_name, mcp_server, mcp_source, mcp_tool, skill_name, input (BLOB), response (BLOB), started_at, ended_at, ok, denied, exit_code | Indexes `(session_id, tool_name)`, `(session_id, started_at)` |
| `inventory_usage` | loaded, invoked | Written from the skill signals and calls above |
| `meta` | `skills:<session_id>` | The session's skill signals (listed names, dynamic skills, slash commands), so a rescan can re-join without re-reading lines |

Transcript fields used: `message.content[]` blocks (`tool_use`: `id`, `name`, `input`; `tool_result`:
`tool_use_id`, `is_error`, `content`), `toolDenialKind`, `toolUseResult`, `attributionMcpServer`,
`attributionMcpTool`, `attachment.names`, `attachment.isInitial`, `attachment.skillNames`, and `<command-name>`
in user content.

## Interfaces
- `src/derive/tools.ts` → `parseToolName(toolName, toolInput): { mcpServer; mcpSource; mcpTool; skillName }`, `exitCodeFrom(resultContent): number | null`.
- `src/derive/tool-categories.ts` → `toolCategory()`, `TOOL_CATEGORIES`.
- `src/derive/inventory-usage.ts` → `skillSignals()`, `deriveInventoryUsage()`.
- API: `GET /api/sessions/:id` (timeline chips, "Used" panel), `GET /api/tools`, `GET /api/inventory?kind=`, `GET /api/adoption`, `GET /api/versions`.
- CLI: `export` writes `tool_calls`.

## UI
- Session detail timeline: under each prompt, tool calls as chips grouped by tool with count and total duration. Failed calls are highlighted with their failure count (exit code on hover); denied calls say "denied". `Bash` and `PowerShell` chips include the command's first word. Subagent calls are grouped under a "subagent: <type>" chip.
- Session detail "Used" panel: Skills, MCP and Tools groups, one badge per item with calls and failures (subagents' included), for example `github ×3` or `Bash ×5 · 2 failed`. A skill run only as a slash command has no count.
- Skills & Tools view: "MCP servers" and "Built-in tools" tabs (calls, failures, denials, median duration, category filter); "Skills" tab with loaded / invoked counts; adoption and version panels.

## Edge cases and failure modes
- `tool_use` without a `tool_result` (interrupted, killed, still running): `ended_at` and `ok` are `NULL`; not a failure.
- `tool_result` without a `tool_use` (lost in a compaction or rewrite): ignored.
- MCP server name containing `__`, or a plugin name containing `_`: the split rules above are final unless `attributionMcpServer` is present; a wrong split only affects display and inventory matching, and the raw `tool_name` is kept.
- The same server reached two ways (plugin and claude.ai connector): two MCP rows, told apart by `mcp_source`.
- `Skill` input with none of the expected fields: `skill_name = NULL`; the raw input stays in `transcript_lines`, so a parser fix plus `rebuild` re-parses it.
- No `skill_listing` in the session (older Claude Code): `loaded` falls back to the inventory in scope (see [05](05-inventory-scan.md)).
- Tool inputs and responses over `capture.maxFieldBytes`: stored with a `…[truncated N bytes]` marker. Secrets in commands are removed by `capture.redact` at ingest.
- Windows paths in `input` are not normalized here; [04 — Repo and file attribution](04-repo-file-attribution.md) does that.

## Dependencies
- Depends on: [01 — Session capture](01-session-capture.md), [05 — Inventory scan](05-inventory-scan.md).
- Depended on by: [04](04-repo-file-attribution.md), [06](06-ai-session-summary.md), [07](07-session-review-tier1.md), [09](09-weekly-coaching-digest.md), [10](10-repeat-pattern-detection.md), [12 — Dashboard](12-dashboard.md).

# 01 — Session capture

**Code:** `src/hook.ts`, `src/hook/`, `src/ingest/`, `src/derive/session.ts`, `src/enrich.ts`

## Purpose
Session capture copies every local Claude Code transcript (CLI, VS Code extension, desktop app) into a local
SQLite database, including history from before install. Four lightweight hooks tell it when to read and add the
two things the transcript does not record: git state at session start and approved permission prompts. Every
other feature derives from the transcript lines and hook events stored here.

The transcript JSONL is the source of truth; hooks only decide when to read it. The JSONL field map and flow
diagrams are in [architecture.md](../architecture.md).

## Behaviour

### Read triggers
Ingest never runs inside the hook. It runs in these places:

| Trigger | Runs | Scope |
| --- | --- | --- |
| `Stop` hook (async), once per completed turn | `ingest <session_id>` | That session's main and subagent files; first read after 500 ms; exits at once if the session lock is held |
| `SessionStart` hook | `snapshot <session_id>` | Git state, repo inventory scan, then every changed transcript (catch-up) |
| `SessionEnd` hook | `enrich <session_id>` | That session, final read, git end state, summary |
| Dashboard poll, every `dashboard.pollSeconds` (default 15, `0` disables) | `ingestPendingLocked()` | Every changed transcript; skips sessions whose lock is held |
| `dashboard` start, `init` (backfill), `cc-debrief ingest` | pending ingest | Every changed transcript |

Claude Code writes the transcript asynchronously: the CLI can write a turn's final text a few hundred ms after
`Stop`. Some turns fire no `Stop` at all (interrupted with Esc, ended by denying a permission prompt, ended by an
API error). No read is treated as complete; whatever one read misses, the next trigger picks up from the stored
offset.

### Transcript ingest
`src/ingest/` reads `<claudeDir>/projects/*/<session-id>.jsonl` (main) and
`*/<session-id>/subagents/agent-<id>.jsonl` (subagents, with `agent-<id>.meta.json`).

1. `listTranscripts()` returns each file with session id, agent id (null for main), size and mtime.
2. A file is pending when its size or mtime differs from its `transcripts` row, or it has no row. A never-read file whose last line is older than `retention.days` is skipped without creating a row.
3. `ingestFile()` reads from `transcripts.bytes_ingested` to the last complete line (a trailing partial line waits for the next read). If the file shrank, or its first line's `uuid` changed, it is re-read from 0 and that file's lines are replaced.
4. Each line is parsed with the permissive `TranscriptLine` schema (unknown keys pass; a non-JSON line counts as a parse error and is skipped). Then `redactDeep()` runs on the whole line (see [14 — Local-only and privacy](14-local-only-privacy.md)), then `slimLine()` drops content the tracker never reads back (snapshots, thinking signatures, image data, bookkeeping attachment bodies, repeated tool output, per-line `sessionId` / `cwd`) and caps hook output at 1 KB and tool results at 8 KB. `custom-title`, `ai-title`, `agent-name` and `cost-state` lines are kept whole. Exact rules: `slimLine()` in [architecture.md](../architecture.md).
5. One `transcript_lines` row per line, `payload` = `encodePayload(line)` (deflate-compressed JSON). Unique `(file_id, line_no)`, so re-ingest is a no-op. SQL never reads inside `payload`; derivation decodes it in TypeScript.
6. The new offset, line count and parse errors are written in the same transaction as the inserts. The file's size and mtime (its "done" marker) and `last_ingested_at` are written only after its session is derived, so a failed derive or a killed worker leaves the file pending.
7. The tracker's own `claude -p` sessions are skipped: session ids in `ai_calls` or `self_usage`, or a main transcript with a prompt starting `[cc-debrief:`. Such files are marked `transcripts.internal = 1`. See [15 — Self-usage tracking](15-self-usage-tracking.md).
8. A file that has disappeared from disk gets `transcripts.missing_since`; its stored lines are kept.

### Hooks
`init` writes `node "<home>/.cc-debrief/bin/hook.js" # cc-debrief` (a stable copy, see [13 — CLI](13-cli.md)) for
`SessionStart`, `Stop` (`"async": true`), `PermissionRequest` (only while `capture.permissionHook` is true, the
default) and `SessionEnd` (`"timeout": 3600`). Event list: `SUBSCRIBED_EVENTS`.

1. `src/hook.ts` reads stdin (2 s limit) and parses it as JSON. `routeHook()` requires `session_id` (letters, digits, dashes, up to 100 chars) and `hook_event_name`; other fields pass through. The hook does not load zod, to keep start-up fast.
2. With `CC_DEBRIEF_INTERNAL=1` in the environment it does nothing.
3. **Spawn first**, before SQLite is loaded: `SessionStart` spawns `snapshot <id> --cwd <cwd>`, `Stop` spawns `ingest <id> --expect <hash>`, `SessionEnd` spawns `enrich <id>`, each with `--from-hook`, detached (`stdio: "ignore"`, `windowsHide: true`, `unref()`). A detached child survives only if the hook exits on its own: Claude Code cancels slow `SessionEnd` hooks at a shared 1.5 s budget and takes their children with them. So the hook does no slow work on any event.
4. `Stop` stops there: no SQLite, no `events` row.
5. `SessionStart`, `PermissionRequest` and `SessionEnd` then load SQLite, run `redactDeep()` on the payload and insert one `events` row (`ts` = receipt time, ISO 8601 UTC).
6. The hook never runs git, never reads a transcript, never touches the network, never writes to stdout or stderr and always exits 0. Errors go as one line to `<dataDir>/hook-errors.log` (rotated to `.1` above 1 MiB).

### Workers
- **Turn ingest** (`ingest <id> --from-hook`): waits 500 ms, tries the session lock without waiting (exits if busy), reads the session's files. `--expect` is a 16-hex hash of the `Stop` payload's `last_assistant_message` (the text itself never reaches a command line); if no stored assistant text matches it, the worker waits another 500 ms and reads once more. Then it derives and commits the done markers.
- **Snapshot** (`snapshotSession(db, sessionId, cwd)`): takes the lock (waits up to 5 s), creates the `sessions` row if missing, stores repo, branch and `head_start` (see [04](04-repo-file-attribution.md)), scans the repo's inventory (see [05](05-inventory-scan.md)), then ingests every pending transcript, so sessions whose `SessionEnd` never fired are caught up. The VS Code extension fires `SessionStart` when its panel opens, before any prompt; a session row with no lines is not shown.
- **Enrich** (`enrichSession()`): see [04](04-repo-file-attribution.md) and [06](06-ai-session-summary.md).

A session counts as in progress while it has no `SessionEnd` event and its last line is under 30 minutes old.

### Derivation
`deriveSession(db, sessionId, { full? })` builds the session's derived rows from `transcript_lines` (main and
subagent) plus `events`. When only new lines were appended since the last derive, it reads just the last turn and
the new lines (state in `meta` `derive:<session_id>`); `full: true` (enrich, rebuild) or a changed derive version
or price table forces a full rebuild. Either way the result is the same as a full rebuild.

1. `sessions`: `started_at` / `ended_at` = first / last line timestamp of the main transcript; `cwd` from the `transcripts` row; `entrypoint`, `gitBranch`, `version`, `permissionMode` from the first line carrying them; `surface = surfaceFromEntrypoint()` (`cli`, `claude-vscode` → `vscode`, `claude-desktop` → `desktop`, else `unknown`); `start_reason` from the `SessionStart` event's `source`; `capture` = `hooks` when a `SessionStart` event exists, else `backfill`; `models` from `assistant` lines in order of first use, skipping `<synthetic>` (Claude Code's own error replies); `title` = last `custom-title`, else last `ai-title`; `agent_name` = last `agent-name`; `reported_*` from the last `cost-state` line (see [02](02-token-cost-tracking.md)). The row is upserted, never deleted, so columns written by other workers are kept.
2. `turns`: one per main-transcript `user` line that is a prompt (not `isMeta`, not a tool result, not a command wrapper), `seq` 1..n. `assistant_text` = the turn's assistant text blocks, joined and capped at 32 KB.
3. `instructions_loaded`: one row per path in each `instructions` attachment.
4. `subagents`: one per subagent file, from its `.meta.json` (or the main transcript's `Agent` result when the meta file is missing) and its first / last line.
5. `compactions`: one per `compact_boundary` system line, from `compactMetadata`.
6. `tool_calls`, `file_changes`, `usage` and `inventory_usage` are derived in the same pass by features 02–05.
7. `PermissionRequest` events stay in `events`; [07 — Session review, Tier 1](07-session-review-tier1.md) reads them directly.

**Backfill.** `init` (unless `--no-backfill`) and every `dashboard` start ingest all pending transcripts with AI off,
showing progress. Backfilled sessions get `capture = backfill` and are never summarized automatically.

**Rebuild.** `cc-debrief rebuild` re-derives every session from `transcript_lines`, so it works after Claude Code
has deleted the transcript files. `--reingest` first re-reads every transcript still on disk from offset 0.

## Data
| Table | Key columns | Notes |
| --- | --- | --- |
| `transcripts` | path, session_id, agent_id, size, mtime_ms, bytes_ingested, first_line_uuid, lines, parse_errors, internal, cwd, first/last_ingested_at, missing_since | One row per JSONL file |
| `transcript_lines` | session_id, agent_id, file_id, line_no, uuid, parent_uuid, type, subtype, ts, payload (BLOB) | One row per line: redacted, slimmed, compressed |
| `events` | session_id, event, ts, payload | `SessionStart`, `PermissionRequest`, `SessionEnd`; append-only |
| `sessions` | session_id, started_at, ended_at, cwd, surface, entrypoint, cc_version, capture, start_reason, permission_mode, models, title, agent_name | Repo and git columns by 04, `reported_*` by 02, summary columns by 06, `enriched_at` by enrich, `tier1_version` by 07 |
| `turns` | session_id, prompt_id, seq, user_text, assistant_text, started_at, ended_at | |
| `instructions_loaded` | session_id, file_path, kind, ts | |
| `subagents` | session_id, agent_id, agent_type, description, tool_use_id, started_at, ended_at | |
| `compactions` | session_id, ts, trigger, pre_tokens, post_tokens | |
| `meta` | `schema_version`, `derive:<session_id>` | Migration version, append-derive state |

Every table also has `agent` (default `claude-code`). Tables are created by `src/db/migrations/001_init.sql`.

## Interfaces
- `src/ingest/files.ts` → `listTranscripts()`, `readSubagentMeta()`; `src/ingest/line.ts` → `TranscriptLine`, `slimLine()`, `encodePayload()`, `decodePayload()`; `src/ingest/ingest.ts` → `ingestFile()`, `ingestSession()`, `ingestPending()`, `ingestPendingLocked()`, `commitFiles()`.
- `src/hook/run.ts` → `routeHook(payload, env)`, `runHook(stdin, env, db?, deps?): Promise<void>` (never throws), `expectHash()`; `src/hook/payload.ts` → `HookPayload` (zod, documentation only; the hook does not import it).
- `src/enrich.ts` → `snapshotSession()`, `enrichSession()`, `enrichPending()`; `src/locks.ts` → `withSessionLock()`.
- `src/derive/session.ts` → `deriveSession()`, `surfaceFromEntrypoint()`.
- `src/db/adapter.ts` → `openDb()` (WAL, `foreign_keys=ON`, `busy_timeout=2000`, 8 KB pages for a new file); `src/db/migrate.ts` → `migrate()`.
- `src/claude/settings.ts` → `SUBSCRIBED_EVENTS`, `HOOK_ENTRY_OPTIONS`, `HOOK_MARKER`, `hookCommand()`, `installHooks()`.
- Env: `CC_DEBRIEF_HOME`, `CC_DEBRIEF_DB`, `CLAUDE_CONFIG_DIR`, `CC_DEBRIEF_INTERNAL`, `CC_DEBRIEF_RAW_DUMP` (`1` = the hook also saves raw stdin, for debugging).
- Config: `capture.redact`, `capture.maxFieldBytes`, `capture.permissionHook`, `dashboard.pollSeconds`, `retention.days`.
- CLI: `ingest [session_id] [--since <date>] [--all]`, `snapshot` (hidden), `rebuild [--reingest]`. `doctor` reports last ingest, last hook event, hook errors in 24 h, parse-failure rate and new line types, ingest backlog, and times one hook run (warns above 150 ms).

## UI
- Overview: session counts by surface; sidebar foot with "Local only" and the last ingest time; an "Importing history" progress line while a backfill runs.
- Sessions list: duration, model(s), an "In progress" badge for running sessions and an "imported" tag for backfilled ones.
- Session detail: date, time range, surface, `claude --resume` hint; a turn timeline with prompts, assistant text, nested subagent runs and compaction markers; instruction files in the "Used" panel.

## Edge cases and failure modes
- Invalid hook stdin, or no usable `session_id` / `hook_event_name`: no row, one `hook-errors.log` line, exit 0.
- DB locked beyond `busy_timeout` in the hook: event dropped and logged; the transcript still captures the session.
- Unknown line or attachment type: stored untouched, ignored by derivation, reported by `doctor`.
- One assistant message written as several lines (one per content block): usage deduplicated in [02](02-token-cost-tracking.md); text blocks concatenated.
- Transcript deleted by Claude Code (`cleanupPeriodDays`): stored lines kept, `missing_since` set; dashboard and `rebuild` unaffected.
- No `SessionEnd`, or a `SessionEnd` hook cancelled (terminal killed, crash): per-turn reads already stored most lines; the rest is read by the next `SessionStart`, the dashboard poll or `dashboard` start. A session with no new line for 24 h counts as ended.
- Resumed session (same id): lines append to the same file and derive as one session. `/clear` starts a new session id.
- Forked or rewound session: a new id whose file repeats the parent's lines; each is its own session, and [02](02-token-cost-tracking.md) counts repeated messages once.
- Concurrent workers: per-session lock files under `<dataDir>/locks/`; turn ingest and the poll skip a locked session, `snapshot` and `enrich` wait up to 5 s, then give up.
- Hooks never installed (read-only use): `ingest` and `dashboard` still work; sessions are `backfill`, with no `start_reason` and no permission-prompt counts.
- Windows: the hook command path is quoted; detached spawn uses `windowsHide: true`; if spawning fails, the dashboard catches up.
- Very large transcripts: read in 1 MB chunks, memory stays flat; fields capped by `capture.maxFieldBytes`.

## Dependencies
- Depends on: [13 — CLI](13-cli.md), [14 — Local-only and privacy](14-local-only-privacy.md), [16 — Settings](16-settings.md).
- Depended on by: [02](02-token-cost-tracking.md), [03](03-tool-mcp-skill-usage.md), [04](04-repo-file-attribution.md), [05](05-inventory-scan.md), [06](06-ai-session-summary.md), [07](07-session-review-tier1.md), [12 — Dashboard](12-dashboard.md), [15](15-self-usage-tracking.md).

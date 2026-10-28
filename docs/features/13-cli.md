# 13 — CLI

**Code:** `src/program.ts` (command registration, exit codes), `src/commands/<name>.ts` (one file per command), `src/claude/settings.ts` (hook install and removal)

## Purpose

The `cc-debrief` binary installs the tracker into Claude Code, diagnoses it, maintains its data and starts the dashboard. `init` is the only command that changes Claude Code's configuration, and it never damages existing hooks; `uninit` reverses it exactly. Every other command works on the tracker's own data directory.

## Global behaviour

- Built with commander; binary `cc-debrief` → `dist/cli.js`. `--version` and `--help` work on every command.
- Normal output goes to stdout; errors go to stderr as `error: <message>`.
- Environment: `CC_DEBRIEF_HOME` (data directory, default `~/.cc-debrief`), `CC_DEBRIEF_DB` (database path, default `<data dir>/tracker.db`), `CLAUDE_CONFIG_DIR` (Claude Code's directory, default `~/.claude`).

| Exit code | Meaning |
| --- | --- |
| 0 | Success (including `doctor` with warnings only) |
| 1 | Runtime failure, or `doctor` found a failing check |
| 2 | Usage error: unknown command or flag, unknown config key, invalid config value, conflicting flags, confirmation needed in a non-interactive shell, export target exists |
| 3 | Refused: `settings.json` is not valid JSON (`init`, `uninit`) |

## Command reference

| Command | Flags | What it does |
| --- | --- | --- |
| `init` | `--no-backfill` | Install hooks, import existing transcripts |
| `uninit` | | Remove hooks, restore `settings.json`; keeps data |
| `doctor` | | Check install, hooks, database and capture health |
| `ingest [session_id]` | `--since <date>`, `--all` | Read new transcript lines into the database |
| `enrich [session_id]` | `--ai`, `--no-ai`, `--since <date>`, `--limit <n>` | Finish sessions: git end state, line counts, AI summary |
| `scan [path]` | | Rescan skills, plugins, MCP servers and hooks |
| `dashboard` | `--port <n>`, `--no-open` | Serve the dashboard on `127.0.0.1` |
| `export` | `--format json\|csv`, `--out <path>`, `--days <n>`, `--repo <repo_id>`, `--include-raw`, `--force` | Write sessions, usage and tool calls to files |
| `purge` | `--all`, `--yes`, `--dry-run` | Delete old data now, or everything |
| `rebuild` | `--reingest` | Re-derive every session from stored lines |
| `recap` | see below | Print what you worked on, grouped by repo |
| `digest` | `--days 7\|30`, `--format text\|md\|json`, `--repo <id>`, `--no-ingest` | Spend and coaching digest in the terminal |
| `config get [key]` / `config set <key> <value>` | | Read or change `config.json` |
| `snapshot <session_id>` (hidden) | `--cwd <path>` | Run by the `SessionStart` hook only |

Hidden flags used only by hook workers: `--from-hook` on `ingest`, `enrich` and `snapshot` (run silently, log errors to `hook-errors.log`, always exit 0), and `--expect <hash>` on `ingest`.

### Hooks installed

`init` subscribes to four Claude Code events, in this order: `SessionStart`, `Stop`, `PermissionRequest`, `SessionEnd`. `PermissionRequest` is installed only while `capture.permissionHook` is true (the default, [16](16-settings.md)). The `Stop` entry has `"async": true` (Claude Code does not wait for it); the `SessionEnd` entry has `"timeout": 3600` so the end-of-session worker is not cut short. Everything else comes from the transcript ([01](01-session-capture.md)).

Each entry's command is `node "<data dir>/bin/hook.js" # cc-debrief`. The `# cc-debrief` marker is a shell comment (Claude Code runs command hooks in Git Bash or PowerShell, never `cmd.exe`), and it is how the tracker recognises its own entries.

### `init`

1. Create the data directory and database, run migrations; write an empty `config.json` if none exists.
2. Copy the package's self-contained `dist/hook.js` and `dist/cli.js` into `<data dir>/bin/` and write `bin/version`. Hooks run this copy, so capture keeps working after `npx cc-debrief init` even when npm cleans its cache.
3. Install the hooks into `settings.json`:
   - Missing file: treated as `{}`. Invalid JSON: nothing written, path printed, exit 3.
   - The original bytes are backed up to `settings.json.cc-debrief-<YYYYMMDD-HHMMSS>.bak` beside it.
   - For each event: an identical tracker entry is skipped; a tracker entry with a different command or options is updated in place; otherwise a new entry is appended. Tracker entries under events the tracker no longer uses (or `PermissionRequest` with the key off) are removed. Other entries are never modified or reordered.
   - Indentation, line endings, trailing newline, BOM and key order are preserved. The write is atomic (temp file, then rename) and re-read; if the re-read fails, the backup is restored and `init` exits 1.
   - The backup path, hashes of the original and written bytes, and the keys it created are recorded in `meta` (`init.*`) for `uninit`.
4. Scan the user-level inventory.
5. Unless `--no-backfill`, import every transcript on disk with AI off. Imported sessions are never summarized automatically.
6. Print what changed and whether AI summaries are on.

```text
$ cc-debrief init
Data dir      ~/.cc-debrief (created)
Database      ~/.cc-debrief/tracker.db (schema v9)
Hook          ~/.cc-debrief/bin/hook.js (v0.2.0 copied)
Settings      ~/.claude/settings.json
  backup      ~/.claude/settings.json.cc-debrief-20260927-091502.bak
  added       4 hooks: SessionStart, Stop (async), PermissionRequest, SessionEnd
  skipped     0 (already present)
Inventory     6 user skills, 2 plugins, 3 MCP servers, 1 hook set
History       imported 283 sessions (41 days, 470 MB of transcripts) in 38 s · no AI used
AI summaries are ON for new sessions: each finished session makes one `claude -p` call
on your plan (max 50/day). Turn off: cc-debrief config set ai.summaries.enabled false
Imported sessions are not summarized. To summarize some: cc-debrief enrich --ai --since 2026-08-28
Next: run `cc-debrief doctor` to check the install.
```

Re-running `init` is safe: present entries are reported as skipped. After upgrading the package, `init` re-copies `bin/` and imports anything new; the hook command path does not change.

### `uninit`

1. Read `settings.json`. Invalid JSON: nothing written, exit 3. Missing: "nothing to remove", exit 0.
2. If the file is byte-identical to what `init` wrote and the backup still matches the original, the backup bytes are restored verbatim (or the file is deleted if `init` created it).
3. Otherwise (the file changed since `init`), every hook whose command contains `# cc-debrief` is removed. A matcher group, event array or `hooks` key is removed only if that removal left it empty and `init` had created it.
4. Delete `<data dir>/bin/`. The database, config and backups are kept.

```text
$ cc-debrief uninit
Removed 4 hooks from ~/.claude/settings.json (restored original bytes)
Your data is kept in ~/.cc-debrief. To delete it: cc-debrief purge --all
```

### `doctor`

Each check prints `PASS`, `WARN` or `FAIL`; any `FAIL` gives exit 1.

| Check | FAIL when | WARN when |
| --- | --- | --- |
| Node version | below 22.13 | |
| `claude` on PATH | missing while AI summaries are on | missing while summaries are off; version unreadable |
| Hook entries | a subscribed event is missing, `Stop` lacks `async: true`, `bin/hook.js` or `bin/cli.js` missing, `settings.json` unreadable | hooks not installed (read-only use); `SessionEnd` lacks its timeout; tracker entries under unused events; an entry runs another `hook.js`; `bin/` older than the package |
| Hook time | | one timed hook run (Node start included) above 150 ms; suggests turning off `capture.permissionHook` |
| Database | not writable | |
| Claude Code transcripts | | (size of `~/.claude/projects` reported) |
| Config | invalid values (defaults used) | unknown keys; a redact pattern that does not compile or takes over 5 ms on 32 KB |
| Transcript parse failures | over 10% of lines in the last 20 sessions | over 1%, or unknown line types (listed with the Claude Code version) |
| Ingest backlog | | transcripts changed over 1 h ago but not ingested |
| Last ingest / hook event | | no ingest in 7 days; hooks installed but no hook event in 7 days while transcripts changed |
| Transcript cleanup | | Claude Code's `cleanupPeriodDays` shorter than `retention.days` |
| Hook errors | | entries in `hook-errors.log` in the last 24 h |
| File permissions (POSIX) | | data dir not `0700`, or database or config not `0600` |
| Summaries | | summary failures in the last 7 days (with the most common reason); more than 20 pending; `ai.model` rejected by the last call |
| Pending enrichment | | sessions not enriched for over 1 h |
| Internal environment | | `CC_DEBRIEF_INTERNAL` set in this shell (sessions started from it are not recorded) |

```text
$ cc-debrief doctor
PASS  Node 22.14.0 (>= 22.13)
PASS  claude 2.4.1 on PATH
PASS  4/4 hook entries in ~/.claude/settings.json
PASS  hook run 84 ms, Node start included
PASS  DB writable (~/.cc-debrief/tracker.db, 84.2 MB)
PASS  config valid
WARN  transcript parse failures 1.8% (37 of 2,051 lines, last 20 sessions)
PASS  ingest up to date (283 transcripts on disk)
...
1 warning, 0 failures
```

### `ingest [session_id]`

With an id, reads that session's main and subagent transcripts. Without, reads every transcript whose size or modification time changed. `--since <date>` limits to files modified after the date; `--all` also re-checks every file's first-line identity. Never calls `claude -p` and never runs git. Works without `init`.

The `Stop` hook runs `ingest <session_id>` in the background after every turn. If another process holds the session's lock, it exits at once; the holder or the next trigger reads the new lines.

### `enrich [session_id]`

Finishes sessions: reads the rest of the transcript, records the git end state and line counts, and writes the AI summary ([06](06-ai-session-summary.md)). With an id, enriches that session (unknown id: exit 1). Without, it ingests pending transcripts, enriches sessions not enriched yet (at most `--limit`, default 100), then summarizes hook-captured sessions whose summary is pending.

- `--no-ai`: never call `claude -p`. `--ai` (the default) allows it.
- `--since <date>` with `--ai`: also summarize imported sessions started after the date, within the daily cap.
- A failed summary is recorded on the session and does not change the exit code.
- Every run ends with cleanup of the tracker's own call leftovers ([15](15-self-usage-tracking.md)) and automatic retention ([14](14-local-only-privacy.md)).

The `SessionEnd` hook runs `enrich <session_id>` in the background.

### `scan [path]`

Rescans user-level skills, plugins, MCP servers and hooks, and, if `path` (default: the current directory) is inside a git repo, that repo's ([05](05-inventory-scan.md)). Read-only on disk. A path outside a repo scans the user level only and exits 0.

```text
$ cc-debrief scan ~/src/billing-api
user   6 skills · 9 plugin skills · 2 plugins · 3 MCP servers · 1 hook set
repo   billing-api: 4 skills (1 lazy) · 2 MCP servers · 0 hooks
```

### `dashboard`

1. Clean up the tracker's own call leftovers and run automatic retention.
2. Scan the user level and every repo with sessions in the last 30 days.
3. Import pending transcripts before serving when at most 50 sessions are pending; a larger backlog (a first run without `init`) continues in the background with progress shown in the UI.
4. Listen on `127.0.0.1:<port>` (`--port`, else `dashboard.port`, default 4242) and open the browser unless `--no-open`. Port in use: exit 1 with a hint.
5. In the background: enrich pending sessions without AI (batches of 200), re-price sessions after a pricing change, then run session checks ([07](07-session-review-tier1.md)), digest rules ([09](09-weekly-coaching-digest.md)) and pattern detection ([10](10-repeat-pattern-detection.md)).
6. Every `dashboard.pollSeconds` (default 15; `0` turns it off), read changed transcripts so open sessions stay current.
7. Run until Ctrl+C.

```text
$ cc-debrief dashboard
scan: 18 skills, 3 MCP servers · ingest: 2 transcripts · enrich: 2 pending (no AI)
cc-debrief dashboard on http://127.0.0.1:4242  (Ctrl+C to stop)
```

### `export`

Writes sessions, usage and tool calls (with their decoded input, not the response).

- `--format json` (default): one file `<out>.json` with `{ exportedAt, version, sessions, usage, tool_calls }`.
- `--format csv`: `<out>-sessions.csv`, `<out>-usage.csv`, `<out>-tool_calls.csv`.
- `--include-raw`: also the stored transcript lines and hook events (the most sensitive data; `-transcript_lines.csv` and `-events.csv` in CSV).
- `--out` defaults to `./cc-debrief-export-<YYYYMMDD>`. `--days <n>` and `--repo <repo_id>` filter sessions.
- Existing files are not overwritten without `--force` (exit 2). Files are created `0600` on POSIX.
- Every string is redacted again with the current `capture.redact` list, so patterns added after capture also apply.

```text
$ cc-debrief export --format csv --days 30
wrote cc-debrief-export-20260927-sessions.csv (212 rows)
wrote cc-debrief-export-20260927-usage.csv (9,418 rows)
wrote cc-debrief-export-20260927-tool_calls.csv (14,002 rows)
```

### `purge`

Without `--all`, deletes data older than `retention.days` now; with `--all`, deletes everything except `config.json`, `drafts/` and the record `uninit` needs. `--all` asks for confirmation on a terminal; elsewhere it needs `--yes` (exit 2 otherwise). `--dry-run` prints the counts and deletes nothing. Full rules in [14](14-local-only-privacy.md).

```text
$ cc-debrief purge --dry-run
would delete 38 sessions older than 90 days (41,220 transcript lines, 12.4 MB)
```

### `rebuild`

Drops and re-derives every session's derived rows (`sessions`, `turns`, `usage`, `tool_calls`, `file_changes`, `subagents`, `compactions`, `repos`, `inventory_usage`, `instructions_loaded`) from the stored transcript lines and hook events, one transaction per session. Sessions whose transcript files Claude Code has deleted rebuild fully from the stored copy. AI results (summary, AI session type, outcome, tags, summary error), `enriched_at` and the git start and end commits are kept; findings, reviews, patterns, self-usage, rule feedback, inventory and `meta` are not touched. Never calls `claude -p`.

`--reingest` first re-reads every transcript file still on disk from the start; files no longer on disk keep their stored lines.

```text
$ cc-debrief rebuild
rebuilt 1,204 sessions from 402,118 transcript lines and 3,850 hook events · 311 transcript files no longer on disk (rebuilt from stored lines)
```

### `recap`

Prints the work recap ([17](17-work-recap.md)) to stdout. Reads new transcript lines first (no AI) unless `--no-ingest`.

| Flag | Effect |
| --- | --- |
| `--today` (default), `--yesterday`, `--date <YYYY-MM-DD>`, `--week` | One range; `--week` is today and the 6 days before it |
| `--from <YYYY-MM-DD>` [`--to <YYYY-MM-DD>`] | A custom range; `--to` defaults to today |
| `--by-day` | One section per day with work |
| `--no-files` | Leave out the file lines |
| `--markdown`, `--json` | Markdown, or the `Recap` JSON object |
| `--polish` | Rewrite with one `claude -p` call |
| `--no-ingest` | Skip reading new transcript lines |

| Case | Exit | Output |
| --- | --- | --- |
| Recap printed, including an empty range | 0 | stdout |
| Two range flags, `--to` without `--from`, `--date` with `--to` | 2 | `error: use one of --today, --yesterday, --date, --week, --from` |
| Bad date, `from` after `to`, more than 366 days | 2 | `error: invalid date "<x>"`, `error: from is after to`, `error: range longer than 366 days` |
| `--markdown` with `--json` | 2 | `error: use one of --markdown, --json` |
| `--polish` failed | 1 | the plain recap on stdout, then `error: polish failed: <reason>` |

`--polish` prints the estimate to stderr first (`polishing with one claude -p call (~$0.01)`, or `(cost unknown)`), then the polished recap. An empty range makes no call.

```text
$ cc-debrief recap --yesterday
Sun, Sep 27 2026

billing-api
  • Add retry with backoff to the invoice sync
    sync.ts, sync.test.ts, client.ts +1
```

### `digest`

Prints, with no AI call: spend for the last 7 (default) or 30 days and the change against the period before, the top 5 repos by cost, the budget pace (when a budget is set), spend spikes, the cache hit rate, then the coaching digest items ([09](09-weekly-coaching-digest.md), [18](18-activity-costs-budget.md)). Reads new transcript lines first unless `--no-ingest`. Output contains no prompt text and no full paths. Any `--days` other than 7 or 30, or an unknown format, exits 2.

### `config get|set`

- `config get` prints the effective config (defaults merged) as JSON; `config get <key>` prints one dotted key.
- `config set <key> <value>` parses `true`/`false` as booleans, `null` as null, numbers as numbers, text starting with `[` or `{` as JSON, and anything else as a string. An empty string removes the key so its default applies. The whole config is validated before writing; an unknown key or invalid value exits 2 and writes nothing. Keys: [16](16-settings.md).

```text
$ cc-debrief config set ai.review.enabled true
ai.review.enabled = true   (was false)
$ cc-debrief config get ai.maxPerDay
50
```

## Data

- `settings.json` in Claude Code's directory: written by `init` and `uninit` only.
- `meta`: `init.*` (the uninit record), `last_retention_run`.
- Claude Code transcripts (`<claude dir>/projects/**/*.jsonl`): read-only.
- `config.json`: written by `config set` (and created empty by `init`).
- All tracker tables: written by `ingest`, `snapshot`, `enrich`, `scan`, `purge`, `rebuild`; read by `export`, `recap`, `digest`.

## Edge cases and failure modes

- `settings.json` with comments or trailing commas (not valid JSON): `init` and `uninit` refuse and print the path.
- `settings.json` is a symlink: read and written through the link target.
- A user directory with spaces: the hook command quotes the path.
- Two `init` runs at once: the second sees the first's entries and skips them; the atomic rename prevents torn writes.
- `uninit` after `purge --all`: the `init.*` record survives `purge --all`, so the byte-identical restore still works.
- `dashboard` or `ingest` without `init`: works read-only; the sidebar says hooks are not installed.
- `init --no-backfill`, then `dashboard`: the dashboard imports pending transcripts anyway.
- An interrupted import (Ctrl+C): progress is committed per file, so the next run resumes.
- `enrich` and `snapshot` for the same session at once: a per-session lock serialises them.

## Dependencies

[01 — Session capture](01-session-capture.md), [04 — Repo and file attribution](04-repo-file-attribution.md), [05 — Inventory scan](05-inventory-scan.md), [06 — AI session summary](06-ai-session-summary.md), [12 — Dashboard](12-dashboard.md), [14 — Local-only and privacy](14-local-only-privacy.md), [16 — Settings](16-settings.md), [17 — Work recap](17-work-recap.md).

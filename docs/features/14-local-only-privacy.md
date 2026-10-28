# 14 — Local-only and privacy

**Code:** `src/redact.ts` (redaction, field caps), `src/db/queries/retention.ts` (retention, purge), `src/server/security.ts` (dashboard request checks), `src/commands/purge.ts`

## Purpose

Claude Code transcripts and hook payloads contain source code, prompts, file paths and sometimes secrets. cc-debrief keeps a copy of them in one SQLite file on your machine. This page states what is stored, where, what is stripped before storing, what leaves the machine, and how to delete it.

## Summary

- Everything is stored under `~/.cc-debrief/` (or `CC_DEBRIEF_HOME`). Nothing is uploaded anywhere by the tracker.
- The only process that talks to a network service is `claude -p`, Claude Code's own CLI, run for the opt-in AI features on your own Claude Code login. Summaries are on by default and can be turned off.
- Known secret formats are replaced with `[REDACTED]` before anything is written.
- The dashboard listens on `127.0.0.1` only.
- Data older than 90 days (configurable) is deleted automatically; `cc-debrief purge --all` deletes everything.

## What is stored, and where

| Path | Contents | Mode (POSIX) |
| --- | --- | --- |
| `~/.cc-debrief/tracker.db` (`-wal`, `-shm`) | Sessions, turns, token usage, tool calls, file changes, hook events, AI summaries and reviews, and a slimmed, redacted copy of every transcript line | `0600` |
| `~/.cc-debrief/config.json` | Your settings ([16](16-settings.md)) | `0600` |
| `~/.cc-debrief/bin/` | The copy of `hook.js` and `cli.js` that Claude Code's hooks run | directory `0700` |
| `~/.cc-debrief/drafts/` | Skill and CLAUDE.md drafts you generate ([11](11-skill-claudemd-suggestions.md)) | `0700` / files `0600` |
| `~/.cc-debrief/hook-errors.log`, `coach-errors.log` | Error messages from background workers | `0600` |
| `~/.cc-debrief/locks/` | Per-session lock files | `0700` |
| `~/.cc-debrief/raw/` | Only when `CC_DEBRIEF_RAW_DUMP=1` is set (debugging): each hook payload as received, **not redacted** | `0700` / files `0600` |
| `~/.claude/settings.json.cc-debrief-<timestamp>.bak` | Backup of Claude Code's settings taken by `init` | same as the original |
| Export files | Only when you run `cc-debrief export` | `0600` |

`CC_DEBRIEF_DB` moves the database file on its own. Directories are created `0700` and files with explicit `0600` modes; the database files are `chmod`ed to `0600` after opening, since SQLite creates `-wal` and `-shm` lazily. On Windows, files inherit your user profile's permissions and `doctor` reports the check as not applicable.

Long text is slimmed before storage: tool results are cut to 8 KB and hook output to 1 KB, and every other text field is capped at `capture.maxFieldBytes` (default 32 KB). Stored payloads are deflate-compressed; compression is not protection, the file mode and the local-only dashboard are.

## Network and processes

The tracker makes no network connection of its own: no telemetry, no update check, no crash reporting, no CDN assets (fonts are bundled into the UI). It starts these processes:

| Process | When | Network |
| --- | --- | --- |
| `claude -p` | AI summaries (on by default), Tier 2 reviews, skill drafts and recap polish (off until you use them) | Yes, through your own Claude Code login, like any Claude Code session |
| `git` | Reading repo state: `rev-parse`, `symbolic-ref`, `remote -v`, `log`, `diff --numstat`, `ls-files` | No (never `fetch`, `pull` or `push`) |
| `node <data dir>/bin/cli.js` | Background workers spawned by the hooks | No |
| The OS browser opener (`start`, `open` or `xdg-open`) | `cc-debrief dashboard`, unless `--no-open` | Opens the local URL |
| `claude --version` and one timed `hook.js` run | `cc-debrief doctor` | No |

`hook.js` itself makes no network call and never runs git.

Each `claude -p` call sends a prompt built from your stored, already-redacted session data (for a summary: the session's turns; for recap polish: only the recap bullets, file base names and stored summaries). Every call runs with all tools and MCP servers off and a $0.50 spending limit ([15](15-self-usage-tracking.md)). Turn the features off with `cc-debrief config set ai.summaries.enabled false` (reviews and drafts are off by default).

## Local-only dashboard

- Binds `127.0.0.1` only, never `0.0.0.0` or `::`.
- Rejects any request whose `Host` header is not `127.0.0.1:<port>` or `localhost:<port>` (421; DNS-rebinding defence).
- Rejects `POST`, `PUT`, `PATCH` and `DELETE` requests with a foreign `Origin` or a body that is not `application/json` (403; cross-site request forgery defence).
- Sends no CORS headers. There is no login; the loopback bind is the boundary.

## Reading `~/.claude`

Transcript files are opened read-only; nothing under Claude Code's directory is written, moved or deleted, with two exceptions:

- `init` and `uninit` write `settings.json` ([13](13-cli.md)).
- The tracker's own `claude -p` calls make Claude Code write a transcript like any session, in `<claude dir>/projects/<data dir with every non-alphanumeric character as "-">/`. The tracker deletes each one right after the call; `purge` and automatic retention delete any left over. These transcripts are never imported, and hooks fired inside those calls store nothing ([15](15-self-usage-tracking.md)).

Claude Code deletes its own transcripts after its `cleanupPeriodDays` (default 30). The tracker's copy follows `retention.days` instead, so sessions stay complete for the whole retention window.

## Redaction

`redact(text, patterns)` replaces every match with `[REDACTED]`.

1. The pattern list is `capture.redact` (default `["@default"]`). The entry `"@default"` expands in place to the built-in `DEFAULT_REDACT` list below, so upgrades can ship new default patterns while you keep your own. Remove `"@default"` to turn the built-ins off.
2. A pattern is a plain regex body (compiled with flag `g`) or `/body/flags` (the given flags plus `g`). Patterns apply in list order. A pattern that does not compile is skipped, never fatal; `doctor` reports it, and also warns about a pattern that takes over 5 ms on a 32 KB sample.
3. Redaction runs before any insert, on every string value:
   - hook payloads, before the `events` insert;
   - each transcript line, before it is slimmed and stored (so a cut can never leave half a secret unmatched); everything derived from the lines inherits the redaction;
   - AI output (summaries, reviews, drafts), because a model can echo a secret;
   - `export`, again with the current list, so patterns added later also apply to exports.
4. Redaction runs before field capping. A capped field ends with `…[truncated N bytes]`; the marker counts toward the cap, and JSON values are capped per string so they stay valid JSON.

Built-in patterns (`DEFAULT_REDACT`, JavaScript regex source written with `String.raw`; `src/redact.ts` holds the same text):

```ts
export const DEFAULT_REDACT: string[] = [
	// Anthropic API and OAuth keys: sk-ant-api03-..., sk-ant-oat01-...
	String.raw`/\bsk-ant-[A-Za-z0-9_-]{20,}/g`,
	// OpenAI keys: sk-..., sk-proj-..., sk-svcacct-..., sk-admin-...
	String.raw`/\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g`,
	// AWS access key id
	String.raw`/\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g`,
	// AWS secret access key when assigned
	String.raw`/(?<=\baws_secret_access_key["']?\s*[:=]\s*["']?)[A-Za-z0-9\/+=]{40}/gi`,
	// GitHub classic tokens: ghp_, gho_, ghu_, ghs_, ghr_
	String.raw`/\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g`,
	// GitHub fine-grained personal access tokens
	String.raw`/\bgithub_pat_[A-Za-z0-9_]{22,255}\b/g`,
	// Bearer tokens (keeps the word "Bearer")
	String.raw`/(?<=\bbearer\s+)[A-Za-z0-9\-._~+\/]{16,}=*/gi`,
	// PEM private key blocks (RSA, EC, OPENSSH, ENCRYPTED, PKCS#8)
	String.raw`/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/g`,
	// Generic assignments: password=..., "api_key": "...", secret: ..., token=... (keeps the key name)
	String.raw`/(?<=\b(?:password|passwd|pwd|secret|client_secret|api[_-]?key|access[_-]?token|auth[_-]?token)["']?\s*[:=]\s*["']?)[^\s"',;&]{4,}/gi`,
	// Password in URLs: scheme://user:PASSWORD@host
	String.raw`/(?<=:\/\/[^\s:@\/]+:)[^\s@\/]+(?=@)/g`,
	// Slack tokens
	String.raw`/\bxox[abprs]-[A-Za-z0-9-]{10,}/g`,
	// Google API keys
	String.raw`/\bAIza[0-9A-Za-z_-]{35}\b/g`,
	// JSON Web Tokens
	String.raw`/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g`,
];
```

Example: `curl -H "Authorization: Bearer sk-ant-api03-AbC...xyz" https://u:hunter22@db.local` is stored as `curl -H "Authorization: Bearer [REDACTED]" https://u:[REDACTED]@db.local`.

Limits: redaction matches known formats only. A secret in an unrecognised format, or split across two lines or content blocks, is stored as is; add your own pattern in Settings or with `config set capture.redact`. False positives (a test fixture that looks like a key) are accepted and stored as `[REDACTED]`.

## Work recap output

The work recap ([17](17-work-recap.md)) is text meant to be pasted elsewhere, so it is stricter than the dashboard: it never includes prompt text, shows file base names only (never directories), and drops every repo in `recap.hiddenRepos` before grouping, copying or building the polish prompt. Hiding a repo cannot remove words about that work from a title or summary in another repo; the Settings page says so.

## Retention

1. `retention.days` (default 90; `0` keeps everything) sets the cutoff, now minus that many days.
2. Automatic retention runs on `dashboard` start and at the end of `enrich`, at most once per 24 hours.
3. A session is dated by its latest activity (newest transcript line, start or newest hook event), so a session resumed over months is not deleted while in use.
4. It deletes each session older than the cutoff with all its rows: stored transcript lines, hook events, turns, usage, tool calls, file changes, subagents, compactions, inventory usage, instructions loaded, findings and reviews. The session's transcript record is kept, marked purged and read to the end, so the file is not imported again while Claude Code still has it; ingest also skips transcripts whose last line is older than the cutoff.
5. It also deletes self-usage and AI-call ledger rows, session-less findings and orphan hook events older than the cutoff, expired dismissals, `raw/` files and leftover call transcripts older than the cutoff.
6. It keeps repos, inventory, patterns, rule feedback, `config.json` and `drafts/`.

## Delete your data

| Command | Effect |
| --- | --- |
| `cc-debrief purge` | Runs retention now, then `VACUUM`. With `retention.days` 0 it deletes nothing and says so |
| `cc-debrief purge --all` | Deletes every row of every table except the schema version and the `init.*` record (so `uninit` can still restore `settings.json` byte for byte), deletes `raw/` and all leftover call transcripts, empties `hook-errors.log`, runs `VACUUM`. Keeps `config.json` and `drafts/`. Transcripts still on disk are not re-imported afterwards (`ingest --all --since <date>` imports them deliberately). Asks for confirmation, or needs `--yes` outside a terminal |
| `--dry-run` (either form) | Prints exactly what would be deleted, deletes nothing |
| `cc-debrief uninit`, then delete `~/.cc-debrief/` | Full removal: hooks out of `settings.json`, all data gone |

```text
$ cc-debrief purge --dry-run
would delete 38 sessions older than 90 days (41,220 transcript lines, 12.4 MB)
```

Copies you make yourself (exports, a copied `tracker.db`) are outside the tracker's control.

## Interfaces

```ts
// src/redact.ts
export const DEFAULT_REDACT: string[];
export function redact(text: string, patterns: string[]): string;   // replaces with "[REDACTED]"
export function capField(text: string, maxBytes: number): string;   // "…[truncated N bytes]"
export function redactDeep<T>(value: T, patterns: string[], maxBytes: number): T; // string leaves of JSON
export function expandPatterns(list: string[]): string[];            // "@default" -> DEFAULT_REDACT
```

`purgeOlderThan(db, cutoff)`, `purgeAll(db)` and `runRetention(db, cfg)` in `src/db/queries/retention.ts`. Config: `capture.redact`, `capture.maxFieldBytes`, `retention.days`, `dashboard.port`. Environment: `CC_DEBRIEF_HOME`, `CC_DEBRIEF_DB`, `CC_DEBRIEF_RAW_DUMP`.

## UI

The sidebar status line reads "Local only". The Settings page's "Capture & retention" section edits the redaction list (with a box to test patterns against sample text), the field cap and the retention window, and previews how many sessions a lower window would delete ([16](16-settings.md)).

## Dependencies

[01 — Session capture](01-session-capture.md), [06 — AI session summary](06-ai-session-summary.md), [12 — Dashboard](12-dashboard.md), [13 — CLI](13-cli.md), [15 — Self-usage tracking](15-self-usage-tracking.md), [16 — Settings](16-settings.md).

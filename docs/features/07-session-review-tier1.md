# 07 — Session review, Tier 1

**Code:** `src/coach/tier1.ts`, `src/coach/context.ts`, `src/coach/signals/`

## Purpose

Tier 1 computes deterministic findings for a session from data already captured: long sessions without compaction,
MCP servers bypassed by raw shell commands, retry loops, context churn and permission friction. It is free, always
on, makes no network call, and ties every finding to a measured consequence (tokens or wait time), never to length
alone.

## Behaviour

1. **When.** `enrichSession()` runs Tier 1 after derivation, repo attribution and inventory usage, and before the AI
   summary, so findings exist even when AI is off or fails. A later `enrich` of the same session reruns it; `rebuild`
   does not touch `findings` (see [13 — CLI](13-cli.md)).
2. **Context.** `loadSessionContext()` loads everything the signals read, once: the `sessions` row, `turns`,
   `tool_calls`, `usage`, `PermissionRequest` events, `compactions`, `subagents`, `file_changes`, `inventory_usage`
   joined with `inventory`, per-column token totals and `userMedianCacheShare`.
3. **Detect.** Each `Signal` runs `detect(ctx)` and returns zero or more `Finding`s (`rule`, `severity`, `message`,
   `evidence`, `costTokens`, `target`, optional `at`). A signal that throws is logged to `coach-errors.log` and keeps
   its previous rows; the other signals still run.
4. **Persist.** Findings are upserted into `findings` keyed by (`session_id`, `rule`, `subject_key`), where
   `subject_key` is `evidence.key` (the tool key, file or server). Existing rows keep `dismissed_until` and
   `feedback`. Rows of a rule that ran but no longer produced them are deleted unless they carry feedback.
   `created_at` is when the finding happened: the finding's own `at` when set, else the session's last activity
   (`coalesce(ended_at, started_at)`), so re-checking old history never puts it in this week's digest.
5. **Re-checks.** `sessions.tier1_version` records the `TIER1_VERSION` (currently 2) a session was checked with. On
   `cc-debrief dashboard` start, sessions active in the last 30 days with an older or missing version are re-checked
   in batches of 50, with progress in `GET /api/status` (`tier1Job`). A session that fails stays pending. Older
   sessions keep the findings of the version that computed them.
6. **Display.** Findings appear only on the session's detail page and in the weekly digest
   ([09](09-weekly-coaching-digest.md)), never as notifications.

### Shared definitions

- **Cost tokens** = input + cache creation + output from `usage` (`costTokensOf()`). Cache reads are left out: they
  are cheap and dominate every long session, so counting them would make every cost look alike. Turn tokens are the
  same sum over rows with that turn. History copied into a fork or rewind belongs to the original session, so it is
  never counted twice ([02](02-token-cost-tracking.md)).
- **Failed call** = `tool_calls.ok = 0` and `denied IS NULL`. Denials also carry `is_error: true` but are not
  failures.
- **Shell tools** = `Bash` and `PowerShell`. Both record a failure as `is_error: true` with content `Exit code N`;
  every rule that reads a command treats them alike. `stderr` on a successful call is never a failure.
- **Cache share** = `cache_read / (input + cache_creation + cache_read)`.
- **`userMedianCacheShare`** = median cache share of the user's other sessions that started in the 30 days before
  this session started and have input-side usage; `null` when fewer than 5 exist. Anchoring on the session's own
  start means a re-check of history gives the same answer.
- **Command key** (`commandKey()` in `src/coach/command-key.ts`): the executable of the first segment of a compound
  command (basename, lowercased, `.exe` stripped; leading `VAR=x`, `sudo` and the PowerShell call operator `&`
  skipped). For `npm`, `pnpm`, `yarn`, `git`, `docker`, `cargo`, `go`, `make`, `uv`, `poetry` the first subcommand is
  appended (`npm test`). `npx X`, `python -m X` and `uv run X` unwrap to `X`.

### Signals

| File | Rule | Fires when | `costTokens` | Severity | Target |
| --- | --- | --- | --- | --- | --- |
| `long-session.ts` | `long_session_no_compaction` | (wall time > 2 h or turns > 40), no `compactions` row, and cache share < `userMedianCacheShare` | `round((median − share) × input-side tokens)` | medium; high if the gap is ≥ 20 points | session |
| `mcp-bypassed.ts` | `mcp_bypassed` | A loaded MCP server and ≥ 1 shell call whose command does that server's job | Tokens of turns with bypass calls, prorated by bypass calls ÷ tool calls in the turn | low; medium if ≥ 3 calls | skills |
| `retry-loop.ts` | `retry_loop` | The same call key fails ≥ 3 times in a row | Cost tokens of `usage` rows from the first failure's start to the closing call's end | medium; high if ≥ 25% of session tokens | session |
| `context-churn.ts` | `context_churn` | The same file is `Read` ≥ 4 times in one session | Sum over reads 2..n of `ceil(original response bytes / 4)` | low; medium if ≥ 8 reads | session |
| `permission-friction.ts` | `permission_friction` | ≥ 8 `PermissionRequest` hook events for one tool in a hook-captured session | 0 (the cost is wait time, in `evidence.waitMs`) | low; medium if ≥ 15 | session |

Messages:

| Rule | Message |
| --- | --- |
| `long_session_no_compaction` | "Long session with no compaction — cache hit {share}% vs your usual {median}%; split it or `/compact`" |
| `mcp_bypassed` | "Raw {command} used {count} time(s); the {server} MCP was available" |
| `retry_loop` | "{key} failed {count} times before passing — {pct}% of session tokens" (or "…in a row without passing — …") |
| `context_churn` | "`{file basename}` read {count} times — pin key facts in CLAUDE.md or keep sessions shorter" |
| `permission_friction` | "{count} prompts for {tool} — consider a permission allowlist" ({tool} adds "({server} MCP)" for MCP tools) |

### Detection details

- **Long session.** Wall time = `ended_at − started_at` minus every gap between turns longer than 1 hour (the
  prompt-cache lifetime), so a session resumed the next day does not count the night. Skipped when
  `userMedianCacheShare` is `null`. Evidence: `wallMinutes`, `turns`, `share`, `median`.
- **MCP bypassed.** Equivalences: a server whose name contains `postgres` or `pg` ↔ `psql`, `pg_dump`; a `github`
  server ↔ `gh`, and `curl`/`wget` to `api.github.com`; any server with a configured URL (`inventory.meta.url`) ↔
  `curl`/`wget` to the same host. Not raised when a call to the same server (same `mcp_server` and `mcp_source`)
  failed before the first bypass, since the user may have fallen back on purpose. "Loaded" comes from
  `inventory_usage` ([05](05-inventory-scan.md)); claude.ai connectors have no inventory row, so they never raise it.
  Evidence: `server`, `command`, `count`, `turns`.
- **Retry loop.** Call key = the command key for shell tools; otherwise the tool name plus its primary target
  (`file_path`, `path`, `pattern` or `url`); otherwise the tool name plus the input JSON. "In a row" counts
  consecutive calls with the same key and ignores calls to other tools in between (an agent edits between test runs).
  A success with that key ends the streak; denied calls and calls without a result neither extend nor break it. One
  finding per streak; a second streak of the same key gets its own subject (`key #2`). Evidence: `key`, `count`,
  `exitCodes`, `firstTurn`, `lastTurn`, `passed`, `pct`.
- **Context churn.** Reads that ran (subagents included, denied reads not) grouped by path, with `\` turned into `/`
  and Windows drive paths compared case-insensitively; `offset`/`limit` ignored. Original bytes come from the stored
  result size or its truncation marker. Evidence: `file`, `count`, `turns`.
- **Permission friction.** `PermissionRequest` events grouped by `tool_name` (MCP tools keep their full `mcp__…`
  name). Approved prompts exist only as hook events; the transcript records denials only. `waitMs` = for each
  request, the time to the result of the next call of that tool. Skipped for imported (`capture = backfill`)
  sessions, whose band shows "Permission prompts: not recorded (imported session)". With
  `capture.permissionHook` off, no `PermissionRequest` events are recorded, so the rule cannot fire. Evidence:
  `tool`, `count`, `denied`, `waitMs`.

## Data

| Table | Access | Notes |
| --- | --- | --- |
| `findings` | write | id, session_id, rule, subject_key, repo_id, severity, message, evidence JSON, cost_tokens, created_at, dismissed_until, feedback, agent (`004_findings.sql`). `evidence.target` holds `Finding.target`. |
| `rule_feedback` | read | Per-rule votes and demotion; owned by [09](09-weekly-coaching-digest.md) |
| `sessions` | read, write `tier1_version` | |
| `turns`, `usage`, `tool_calls`, `file_changes`, `inventory_usage`, `inventory`, `compactions`, `subagents` | read | |
| `events` | read | `PermissionRequest` only |

## Interfaces

- `src/coach/types.ts`: `Severity`, `Finding`, `SessionContext`, `Signal` (`{ rule: string; detect(ctx): Finding[] }`).
- `src/coach/context.ts`: `loadSessionContext(db, sessionId)`, `costTokensOf(usage)`.
- `src/coach/tier1.ts`: `SIGNALS` (the five signals), `TIER1_VERSION`, `runTier1(db, sessionId)`,
  `runTier1Pending(db, { since, limit })`.
- `src/coach/labels.ts`: `RULE_LABELS`, the badge text per rule ("long session", "retry loop", …).
- API: `GET /api/sessions/:id` (findings in the review band), `GET /api/findings?range&repo&session`,
  `POST /api/findings/:id/feedback`, `POST /api/findings/:id/dismiss` ([09](09-weekly-coaching-digest.md)).

## UI

- Session detail, "Session review" band under the summary: each finding as a severity badge with its rule label,
  followed by its message and turn numbers, with helpful / not-helpful buttons. "Dismiss 30d" dismisses all of the
  session's findings. The band also carries the Tier 2 review controls ([08](08-session-review-tier2.md)); with no
  findings it reads "No findings for this session".
- Timeline: tool chips with failures are red and carry a "failed ×N" count, supporting retry-loop evidence.
- Overview digest: top findings ranked by cost ([09](09-weekly-coaching-digest.md)).

## Edge cases and failure modes

- Fewer than 5 earlier sessions with usage: the long-session signal is skipped (no median).
- Session with no `usage` rows: costs are 0; findings are still stored with counts.
- Interrupted turn (Esc) or API error: tool calls already recorded still count; the next trigger or catch-up ingests
  the rest.
- Rule demoted by three not-helpful votes: still computed and stored; the digest ranks it last and it stops counting
  toward the Tier 2 auto-review threshold.
- Dismissed finding: hidden until `dismissed_until`; a rerun does not resurrect it, and `rebuild` keeps it.

## Dependencies

- Depends on: [01 — Session capture](01-session-capture.md), [02 — Token and cost tracking](02-token-cost-tracking.md),
  [03 — Tool, MCP and skill usage](03-tool-mcp-skill-usage.md), [04 — Repo and file attribution](04-repo-file-attribution.md),
  [05 — Inventory scan](05-inventory-scan.md).
- Used by: [08 — Session review, Tier 2](08-session-review-tier2.md), [09 — Weekly coaching digest](09-weekly-coaching-digest.md),
  [12 — Dashboard](12-dashboard.md).

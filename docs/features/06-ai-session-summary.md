# 06 — AI session summary

**Code:** `src/collector/summarize.ts`, `src/claude/headless.ts`, `src/enrich.ts`, `src/commands/enrich.ts`

## Purpose
Asks Claude, through the user's own Claude Code login (`claude -p`, no API key), for a short summary, a session
type, tags and an outcome for each finished session. On by default, capped per day, with a heuristic session type
when AI is off, capped or failing.

## Behaviour

### When a summary runs
- **SessionEnd:** the hook spawns `cc-debrief enrich <id> --from-hook`. `enrichSession()` reads the rest of the transcript, derives, does the git work ([04](04-repo-file-attribution.md)) and Tier 1 ([07](07-session-review-tier1.md)), then calls `summarizeSessionResult()` inside the same session lock, so a second worker sees it done.
- **Catch-up:** after that, the same worker summarizes up to 5 other pending `capture = hooks` sessions from the last 7 days, oldest first, while under the daily cap. This is how capped or missed sessions get summarized without a manual run. Backfilled sessions are never caught up automatically.
- **CLI:** `cc-debrief enrich` (no id) enriches sessions without AI, then summarizes pending hook-captured sessions until the cap. `enrich --since <date>` also summarizes imported sessions started since then, after printing `N sessions · est. ~$X · M left in today's cap`. A hand-typed `enrich <id>` counts as an explicit request. `--no-ai` never calls `claude -p`.
- **Dashboard:** the start-up enrich pass runs without AI. The session detail's Summarize button (`POST /api/sessions/:id/summarize`) and the imported-sessions banner (`GET /api/summaries/estimate`, `POST /api/summaries/run`) are explicit requests.

### Steps (`summarizeSessionResult(db, id, cfg, { explicit })`)
1. **Skip** (status `skipped`, with a reason) when: the session is unknown; it already has an AI summary (`type_source = 'ai'`); `ai.summaries.enabled` is false; it has fewer than 2 turns; it is still open (no `SessionEnd` event and its last line is under 24 h old); or it is `capture = backfill` and the request is not explicit.
2. **Cap.** If today's `ai_calls` rows for `summary` (local calendar day) reach `ai.maxPerDay` (default 50), return `capped`. The binding check is in `runClaude()`: it reserves the attempt's `ai_calls` row with one `INSERT … SELECT` that succeeds only while today's count is below the cap, under SQLite's write lock, and otherwise throws `capped` without spawning. Parallel workers (quitting the desktop app ends every open session at once) cannot all pass, and the retry is checked again.
3. **Prompt.** Fixed instructions followed by a condensed transcript built from the stored `turns`: per turn the prompt (up to 2,000 chars), a tool skeleton and the reply (up to 600 chars). Oldest turns are dropped first to stay within 60,000 characters. The session is never resumed, so the summary works after Claude Code has deleted the transcript.
4. **Call.** `runClaude({ prompt, schema, feature: "summary", model: ai.model, cap })` runs `claude -p --output-format json --json-schema <schema> --tools "" --strict-mcp-config --max-budget-usd 0.50` (plus `--model` when `ai.model` is set), with the prompt on stdin and `CC_DEBRIEF_INTERNAL=1` and `CC_DEBRIEF_FEATURE=summary` in its environment. No tools and no MCP servers are loaded, because the session text is untrusted. Timeout 120 s. The call's own transcript is deleted afterwards. See [15 — Self-usage tracking](15-self-usage-tracking.md).
5. **Validate** against `SummaryResultSchema` (zod). Extra keys are dropped; more than 5 tags are cut to 5. A non-zero exit, timeout, unparseable output or schema mismatch is a failure.
6. **Retry** once on failure, except after a budget error (`--max-budget-usd` is checked after a paid turn, so the same prompt would fail the same way at the same price).
7. **Store** on success: `summary`, `session_type`, `tags`, `outcome` (redacted with `capture.redact`), `type_source = 'ai'`, `summary_error = NULL`; status `done`. The call's tokens and cost go to `self_usage` with `feature = 'summary'`.
8. **On final failure:** `summary_error = "<reason>: <first 120 chars>"` (for example `exit: …`, `timeout: …`, `schema: …`); status `error`. `summary_error` keeps the session out of the pending list and catch-up, but a direct request (a later `SessionEnd`, the Summarize button, `enrich <id>`) may try again.
9. **`claude` not on PATH** is not a session failure: no retry, no `summary_error`, status `skipped` with reason `claude is not on PATH`, so the session stays pending until `claude` is found (`doctor` reports it).
10. **Heuristic type.** On every outcome but `done`, a session without an AI summary gets `session_type = heuristicType(toolCalls)` and `type_source = 'heuristic'`. A later AI summary overwrites it; an AI summary is never replaced.

### Output schema (passed to `--json-schema`)
```json
{ "summary": "string, 2-4 sentences", "session_type": "feature | bugfix | refactor | exploration | ops | docs | other", "tags": ["up to 5 strings"], "outcome": "completed | partial | abandoned | unclear" }
```

### Heuristic rules (`heuristicType`)
Evaluated in order; "mostly" means more than half.
1. At least one `Edit` / `Write` / `MultiEdit` and every one targets a `*.md` file → `docs`.
2. Mostly edit calls, and those edits mostly on test files (a `test/`, `tests/`, `__tests__/` or `spec/` directory, or a name like `*.test.*`, `*.spec.*`, `test_*`, `*_test.*`) → `bugfix`.
3. Mostly `Read` / `Grep` / `Glob` calls → `exploration`.
4. Otherwise (including no tool calls) → `other`.

### Pending state
A session is pending when it has ended, has at least 2 turns, has no AI summary and no `summary_error`
(`pendingSummaryIds()`). `enriched_at` records non-AI enrichment only and does not block a later summary.

## Data
| Table | Columns | Notes |
| --- | --- | --- |
| `sessions` | summary, session_type, type_source (`ai` / `heuristic`), outcome, tags (JSON), summary_error | Written here |
| `turns` | user_text, assistant_text | Prompt input; the 2-turn rule |
| `tool_calls` | tool_name, turn_id, input | Tool skeleton and `heuristicType` |
| `ai_calls` | feature, session_id, target_session_id, ts | One row per attempt, reserved before the spawn; the daily cap |
| `self_usage` | feature, session_id, target_session_id, model, token columns, cost_usd | The call's own usage |

## Interfaces
- `src/collector/summarize.ts` → `summarizeSession()`, `summarizeSessionResult(): Promise<{ status: "done" | "skipped" | "capped" | "error"; costUsd; reason }>`, `heuristicType(toolCalls)`, `pendingSummaryIds()`, `estimateSummaryCost()`, `buildStoredTurnsPrompt()`; `SummaryResultSchema`, `SUMMARY_JSON_SCHEMA`, `SESSION_TYPES`, `OUTCOMES`.
- `src/claude/headless.ts` → `runClaude<T>(opts): Promise<ClaudeResult<T>>`, `ClaudeError` (reasons `not_found`, `capped`, `exit`, `timeout`, `parse`, `schema`, `budget`).
- `src/enrich.ts` → `enrichSession()`, `enrichPending()`, `catchUpSummaries()`.
- CLI: `enrich [session_id] [--no-ai] [--since <date>] [--limit <n>]`; `config set ai.summaries.enabled false`. `enrich <id>` prints `enriched session <id> · summary <status> (<reason>)`.
- Config: `ai.summaries.enabled` (default true), `ai.model` (default unset), `ai.maxPerDay` (default 50).
- API: `GET /api/sessions` (search covers prompts and summaries), `GET /api/sessions/:id` (`summaryState`, `summaryEstUsd`, `summaryCapReached`), `POST /api/sessions/:id/summarize`, `GET /api/summaries/estimate`, `POST /api/summaries/run`, `GET /api/status` (pending count).

## UI
- Sessions list: a type badge and a one-line summary; search "Search prompts and summaries"; a type filter.
- Session detail header: type badge and the summary paragraph with its outcome. A heuristic type is labelled "heuristic"; a failed summary shows "Summary failed" with the reason; a pending one shows "Summary pending" and a Summarize button with its estimated cost (disabled once today's cap is used).
- Overview: recent sessions with their summary; a banner for imported sessions without a summary, with a cost estimate.
- Sidebar foot: "AI: summaries on · reviews off" and the number of pending summaries.

## Edge cases and failure modes
- Transcript deleted by Claude Code before the summary: no effect; the prompt comes from stored turns.
- Over `--max-budget-usd 0.50`: `budget` error, not retried, `summary_error` set; the call's cost is still recorded.
- Cap reached (also when another worker took the last slot between the early check and the spawn): `capped`; the session stays pending for a later catch-up or `enrich`.
- Two enrich workers for one session (for example `SessionEnd` twice after a resume): the second sees `type_source = 'ai'` and skips.
- Hooks fired by the `claude -p` child: ignored (`CC_DEBRIEF_INTERNAL=1`); its transcript is skipped by ingest.
- A tracker call's lines inside a user transcript: excluded from `turns` and `usage` (see [02](02-token-cost-tracking.md)).
- Windows: `claude` resolved through `PATHEXT` (`claude.cmd`), spawned with `windowsHide: true`; a timed-out process tree is killed.

## Dependencies
- Depends on: [01 — Session capture](01-session-capture.md), [03 — Tool, MCP and skill usage](03-tool-mcp-skill-usage.md), [15 — Self-usage tracking](15-self-usage-tracking.md), [16 — Settings](16-settings.md).
- Depended on by: [08](08-session-review-tier2.md) (shares `runClaude` and caps), [10](10-repeat-pattern-detection.md), [11](11-skill-claudemd-suggestions.md), [12 — Dashboard](12-dashboard.md), [17 — Work recap](17-work-recap.md).

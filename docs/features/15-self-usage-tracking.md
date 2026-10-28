# 15 — Self-usage tracking

**Code:** `src/claude/headless.ts` (`runClaude()`), `src/db/queries/selfUsage.ts`, `src/hook/run.ts`, `src/ingest/ingest.ts`

## Purpose

Summaries, Tier 2 reviews, skill drafts and recap polish ([17](17-work-recap.md)) each run `claude -p` on the user's own plan. Those calls must not look like the user's work: they would inflate session counts, tokens and cost, and trigger coaching on the tracker's own prompts. This feature keeps every internal call out of user data, records it in a separate `self_usage` table, and shows what the tracker itself costs on the Overview and the Settings page.

## Behaviour

### Running an internal call

`runClaude()` is the only code that runs `claude`. For every call it:

1. Runs `claude -p --output-format json --json-schema <schema>` in the data directory, with `--model <ai.model>` when a model is pinned, and the fixed limits `--tools "" --strict-mcp-config --max-budget-usd 0.50`: no built-in tool, no MCP server, at most $0.50. The prompt carries untrusted session text and no call needs a tool.
2. Sets `CC_DEBRIEF_INTERNAL=1` and `CC_DEBRIEF_FEATURE=<feature>` in the child's environment, where the feature is `summary`, `review`, `draft` or `recap`.
3. Starts the prompt with the sentinel line `[cc-debrief:<feature>]`, a routing signal for ingest that does not depend on environment inheritance.
4. Never resumes or forks the user's session; callers send a prompt built from stored turns.
5. Reserves an attempt in `ai_calls` (the daily-cap ledger) before spawning. With a cap, the row is inserted by a single `INSERT … SELECT` only while today's (local day) count for the feature is below it, so parallel workers cannot overshoot; otherwise the call fails as `capped` and nothing is spawned. A missing `claude` is detected before the reservation, so it never counts against the cap.
6. On exit, parses the JSON result and inserts the `self_usage` row: tokens (input, output, cache write, cache read), `model`, `cost_usd` = those tokens priced with the price table ([02](02-token-cost-tracking.md)), and `raw_total_cost_usd` = Claude Code's reported `total_cost_usd`. A result that parsed but reports an error still gets its row, since it cost money. On a budget error (`budget`, never retried) the tokens come from `modelUsage`. The model is `ai.model` when pinned, else the model with the most output tokens.
7. Deletes the call's own transcript from Claude Code's project folder for the data directory. A file still held open is left for `purge` and retention ([14](14-local-only-privacy.md)).

A call that crashes or times out leaves an `ai_calls` row with no `self_usage` row and counts as one failed call with unknown cost.

### Keeping internal sessions out of user data

1. **Hook.** `runHook()` does nothing when `CC_DEBRIEF_INTERNAL` is `1`: no `events` row and no worker, so a summary never gets summarized.
2. **Ingest.** Before storing any line of a transcript, ingest checks whether the session is internal: its id is in `self_usage` or `ai_calls`, or any user prompt in the file starts with `[cc-debrief:`. An internal file is marked `internal = 1` and read to the end, so it is never read again; none of its lines are stored.
3. **Race.** If ingest runs while the call is still in flight (no `self_usage` row yet), the sentinel catches it. A worker spawned for an internal session finds it internal and exits.
4. **Cleanup.** `cleanupInternalSessions()` runs on `dashboard` start and at the end of `enrich`; it deletes events and derived rows for internal session ids, in case environment inheritance failed.
5. **Guard.** Lines under a prompt starting with `[cc-debrief:` are left out of turns, usage and tool calls when a session is derived.

User-facing numbers never include internal sessions.

### Aggregation

- **Week** = the rolling 7 days ending now.
- **Tokens** = input + output + cache write + cache read.
- **USD** = sum of `self_usage.cost_usd`; rows with an unpriced model are left out.
- **Share of your usage** = self USD ÷ (user USD + self USD) × 100 over the same period, where user USD is the cost of the user's own sessions. Every share, per feature too, uses that same denominator. USD rather than tokens, because plan limits follow cost-weighted usage more closely and cache reads would otherwise dominate. The API returns it to 2 decimals, or null when the denominator is 0.
- **Calls** = `self_usage` rows plus failed attempts (`ai_calls` rows with no `self_usage` row).
- The footer always covers the last 7 days across all repos, whatever the Overview's range and repo filter (`self_usage` has no repo).

## Data

| Table | Access | Columns |
| --- | --- | --- |
| `self_usage` | written by `runClaude()` only | id, feature (`summary`, `review`, `draft`, `recap`), session_id (unique), target_session_id, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, cost_usd, raw_total_cost_usd, ts, agent |
| `ai_calls` | written by `runClaude()` | one row per attempt: feature, session_id (filled after the call), target_session_id, ts; the daily-cap ledger ([06](06-ai-session-summary.md), [16](16-settings.md)) |
| `transcripts` | `internal = 1` | internal transcript files, never read again |
| `usage` | read | user USD for the share |

Both tables are created in `src/db/migrations/003_self_usage.sql` and pruned by retention.

## Interfaces

- `runClaude<T>(opts)` → `ClaudeResult<T>`; throws `ClaudeError` with a reason (`not_found`, `exit`, `timeout`, `parse`, `schema`, `budget`, `capped`).
- `src/db/queries/selfUsage.ts`: `recordSelfUsage()`, `isInternalSession()`, `cleanupInternalSessions()`, `selfUsageSummary(db, "7d" | "30d")`, `selfUsageLine()`, `aiCallsToday()`.
- `GET /api/self-usage?range=7d|30d` (route in `src/server/routes/config.ts`):

```ts
type SelfUsage = {
  range: "7d" | "30d";
  byFeature: { feature: "summary" | "review" | "draft" | "recap"; calls: number; failed: number;
               tokens: number; cacheReadTokens: number; usd: number; sharePct: number | null }[];
  total: { calls: number; failed: number; tokens: number; usd: number; sharePct: number | null };
  userUsd: number;
};
type SelfUsageLine = { summaries: number; reviews: number; drafts: number; recaps: number; tokens: number;
                       usd: number; sharePct: number | null };   // in the Overview digest footer (09)
```

- Environment: `CC_DEBRIEF_INTERNAL`, `CC_DEBRIEF_FEATURE`.

## UI

**Overview footer** (in the coaching digest card, [09](09-weekly-coaching-digest.md)), followed by a link to Settings:

```text
This package used: 42 summaries + 6 reviews · 310k tokens · $1.40 · 7% of your week
```

Drafts and recaps are added (`+ 2 drafts`, `+ 1 recap`) only when non-zero. The share is shown to the nearest integer, `<1%` when above 0 and below 0.5, and `—` when there is no user cost. With no internal calls: `This package used nothing this week`.

**Settings, "Tracker usage" table** with a 7 days / 30 days toggle: one row per feature (Summaries, Reviews, Drafts; Recaps only when the range has a recap call) and a Total, with columns Calls, Failed, Tokens, Cache read, USD and Share of your usage (one decimal). A caption notes that tracker costs come from the calls' own token counts while user costs are estimates from the price table.

## Edge cases and failure modes

- `claude -p` returns output that is not JSON: no `self_usage` row; the attempt counts as failed. Summaries retry once ([06](06-ai-session-summary.md)); reviews, drafts and recap polish do not.
- Several internal calls at once (for example "Review all"): each gets its own session id and row.
- You set `CC_DEBRIEF_INTERNAL=1` in your own shell: the hook ignores sessions started from it, but ingest still captures them (no sentinel, no ledger row), so only the git start state and permission prompts are lost. `doctor` warns when the variable is set.
- Your own prompt starts with `[cc-debrief:`: the session is treated as internal and skipped. Unlikely by accident.
- Transcripts left by an older tracker version that ran `claude -p`: they carry the sentinel and are skipped on import even without ledger rows.
- All user usage is unpriced: the share shows `—`.
- Recap polish calls have no daily cap, so they never end as `capped`.

## Dependencies

[01 — Session capture](01-session-capture.md), [06 — AI session summary](06-ai-session-summary.md), [08 — Session review, Tier 2](08-session-review-tier2.md), [09 — Weekly coaching digest](09-weekly-coaching-digest.md), [11 — Skill and CLAUDE.md suggestions](11-skill-claudemd-suggestions.md), [12 — Dashboard](12-dashboard.md), [14 — Local-only and privacy](14-local-only-privacy.md), [16 — Settings](16-settings.md), [17 — Work recap](17-work-recap.md).

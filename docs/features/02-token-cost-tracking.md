# 02 — Token and cost tracking

**Code:** `src/collector/transcript.ts`, `src/collector/prices.ts`, `src/derive/session.ts`, `src/derive/pricing.ts`, `src/db/queries/usage.ts`

## Purpose
Claude Code's `/cost` (`/usage`) shows one session at a time and has no export. This feature reads per-message
token usage (input, output, cache write, cache read) and model from each session's transcript, stores it per
assistant message, and prices it with a bundled price table. When the transcript has a `cost-state` line, it also
reads Claude Code's own session totals, so headline numbers match `/cost` exactly. Users see tokens and USD per
session, day, repo and model.

Two facts about the transcript shape this design:
- Deduplicated assistant messages alone undercount `/cost`: background requests (title generation and similar) write no transcript line. `cost-state` lines carry `/cost`'s exact per-model totals, subagents and background calls included, cumulative across `--resume`. CLI transcripts have them; only some desktop ones do.
- Forks, rewinds and desktop branches copy earlier history into a new file under a new session id, so the same `message.id` can appear in several sessions. Per-session dedupe would count it twice.

## Behaviour
Runs inside `deriveSession()` over the session's stored `transcript_lines` (main and subagent), never over the
JSONL file; ingest is in [01 — Session capture](01-session-capture.md).

1. `usageFromLines(lines)` returns one `UsageRow` per assistant API message. Claude Code repeats `usage` on every line of a split message, so rows sharing `message.id` + `requestId` collapse to one (last line wins). Lines without `message.id` or `usage`, and `<synthetic>` lines (Claude Code's own error replies), are skipped. It never throws.
2. Lines under a prompt starting `[cc-debrief:` (a tracker call inside a user transcript) are excluded.
3. **Global dedupe.** A message key (`message_id`, `request_id`) belongs to the earliest-started session holding it. If an earlier session already owns a key, this session's row is dropped; if this session is earlier, it takes the key over, deletes the later session's row and marks that session for re-derivation (`meta` `rederive:<id>`). A unique index on `usage(message_id, COALESCE(request_id, ''))` enforces one owner.
4. `turn_id` = the turn whose window contains the row's `ts`; rows before the first turn get `NULL`.
5. `cost_usd = estimateCost(row, table)` with the effective price table (built-in plus overrides). An unknown model gives `NULL`. Cache writes are split by TTL: the `cache_creation.ephemeral_1h_input_tokens` part at the 1-hour rate (2x input), the rest at the 5-minute rate (1.25x input); cache reads at the model's read rate (0.1x input by default; lower on some newer models, see `PRICE_TABLE`). The 1-hour split is used for pricing only, not stored.
6. **Reported totals.** `costStateFrom(mainLines)` returns the last `cost-state` line's `totalCostUSD` and per-model `inputTokens`, `outputTokens`, `thinkingTokens`, `cacheReadInputTokens`, `cacheCreationInputTokens`, `costUSD`. It is written to `sessions.reported_cost_usd` / `reported_usage` only when the session owns every message key it holds and has no tracker-call lines. A session holding a message owned by an earlier session is a copy, and its `cost-state` includes the parent's usage, so its `reported_*` stay `NULL`.
7. `sessions.models` = distinct main-transcript models in order of first use (`<synthetic>` excluded).
8. Subagent usage (`agent_id` not null) is stored with the session and counted in its total, as `/cost` does.
9. The effective price-table version is stored in `meta` `price_table_version`.

### Session totals
`sessionTotals(db, sessionId)` gives the one number every view and threshold uses:
- **Reported** (when `reported_usage` is set): tokens per type = sum over its models; cost = `reported_cost_usd`. Matches `/cost`, including subagents and background calls.
- **Counted** (otherwise): sums of the session's `usage` rows; cost = sum of non-null `cost_usd`. Flagged `partial` and shown as "at least" (≥), because background requests are not in the transcript.
- **Unattributed usage** = reported minus counted, per token type and model, floored at 0. Per-turn views never show it. Per-day and per-model charts put it on the session's last-activity day and model, so chart totals equal the tiles.

Derived measures: total tokens = input + output + cache write + cache read; cache-read share =
`cache_read / (input + cache_write + cache_read)` from session totals (the "served from cache" tile and coaching
rules).

### Pricing overrides
`pricing.overrides` in `config.json` (see [16 — Settings](16-settings.md)):
`{ "<model id or family>": { "input": n, "output": n, "cacheWrite"?: n, "cacheWrite1h"?: n, "cacheRead"?: n } }`,
in USD per million tokens.
- A family key (`opus`, `sonnet`, `haiku`, `fable`, `mythos`) applies to every id of that family; a model-id key beats it. A key the table does not know adds that model. Missing cache prices follow input as in the built-in table.
- Invalid entries fail `config set` with exit 2 and `PUT /api/config` with 422.
- The effective version is `PRICE_TABLE_VERSION`, or `PRICE_TABLE_VERSION+<8 hex>` (hash of the sorted overrides). A session derived under another version is re-derived in full, which re-prices `usage.cost_usd` and leaves tokens alone. The dashboard runs this as a background job on start and after a config change.
- Reported totals are not re-priced: a session with a `cost-state` line keeps Claude Code's own cost.

**Cache savings** (Costs view, [18](18-activity-costs-budget.md)): per model, cache-read tokens × (input price − cache-read
price), from counted usage rows at the effective table.

## Data
| Table | Columns | Notes |
| --- | --- | --- |
| `usage` | session_id, agent_id, turn_id, message_id, request_id, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, cost_usd, ts | One row per assistant API message across all sessions; unique `(message_id, COALESCE(request_id, ''))` |
| `sessions` | models (JSON array), reported_cost_usd, reported_usage (JSON per model: `input`, `output`, `thinking`, `cacheRead`, `cacheCreation`, `costUsd`) | Written here |
| `meta` | `price_table_version`, `rederive:<session_id>` | |

Transcript fields read: `type`, `timestamp`, `requestId`, `message.id`, `message.model`,
`message.usage.{input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens,
cache_creation.ephemeral_1h_input_tokens}`; `cost-state` → `totalCostUSD`, `modelUsage.<model>.*`.

The tracker's own `claude -p` calls are stored in `self_usage`, never in `usage` (see
[15 — Self-usage tracking](15-self-usage-tracking.md)).

## Interfaces
- `src/collector/transcript.ts` → `usageFromLines(lines): UsageRow[]`, `costStateFrom(lines): CostState | null`, `sessionTitles()`.
- `src/collector/prices.ts` → `PRICE_TABLE`, `PRICE_TABLE_VERSION`, `estimateCost(row, table?): number | null`, `modelFamily()`, `effectivePriceTable()`, `effectivePriceVersion()`.
- `src/derive/pricing.ts` → `activePricing()` (effective table and version); `src/derive/reprice.ts` → `stalePriceSessions()`, `repriceStale()`.
- `src/db/queries/usage.ts` → `sessionTotals(db, sessionId): { tokens; costUsd; source: "reported" | "counted"; partial }`.
- API: `GET /api/overview` (token and cost tiles, tokens-per-day chart), `GET /api/sessions`, `GET /api/sessions/:id`, `GET /api/repos`, `GET /api/costs`.
- CLI: `doctor` reports the parse-failure rate over the last 20 sessions (WARN above 1%, FAIL above 10%); `export` includes `usage`; `rebuild` re-derives from `transcript_lines`.

## UI
- Overview tiles: Tokens (with the share served from cache) and estimated cost (split by model); a "Tokens per day" stacked bar chart (input with cache writes, cache read, output).
- Sessions list: tokens, cost and model(s); a counted total reads "≥ 388k".
- Session detail "Tokens" panel: Input, Cache write, Cache read, Output, Cost.
- Repos table and recent-sessions table: tokens and cost columns.
- A session with no usage rows shows "tokens unknown" instead of 0.

## Edge cases and failure modes
- Transcript deleted by Claude Code after ingest: no effect; usage comes from `transcript_lines`.
- Transcript format change: unknown lines are stored but yield no usage; a session with none shows "tokens unknown"; `doctor` warns or fails on the parse rate. A parser fix plus `rebuild` recovers past sessions.
- Unknown model id: `cost_usd = NULL`, tokens still counted.
- Fork, rewind or branch: repeated messages stay with the parent; the copy counts only its new messages, and its cumulative `cost-state` is not used.
- Backfill order: a fork can be derived before its parent. When the parent is derived, it takes the shared keys over and the fork is re-derived.
- Resumed session (same id and file): `cost-state` is cumulative across the resume, so the last line is the whole session.
- Desktop transcript without `cost-state`: counted totals, shown as "at least".
- `<synthetic>` assistant lines: no `usage` row, not a model.

## Dependencies
- Depends on: [01 — Session capture](01-session-capture.md), [16 — Settings](16-settings.md) (pricing overrides).
- Depended on by: [06](06-ai-session-summary.md), [07](07-session-review-tier1.md), [08](08-session-review-tier2.md), [09](09-weekly-coaching-digest.md), [10](10-repeat-pattern-detection.md), [12 — Dashboard](12-dashboard.md), [15](15-self-usage-tracking.md), [18](18-activity-costs-budget.md).

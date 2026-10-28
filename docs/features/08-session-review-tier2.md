# 08 — Session review, Tier 2

**Code:** `src/coach/review.ts`, `src/coach/review-band.ts`, `src/db/queries/reviews.ts`

## Purpose

Deterministic signals cannot tell whether a session drifted between goals, where the ask was ambiguous, or what a
better first prompt would have been. Tier 2 sends the session's stored turns to `claude -p` with a fixed review
schema, passes the Tier 1 findings in as evidence, and gets back goals, goal changes, friction points, a better
approach and a suggested first prompt. It spends the user's plan usage, so it is opt-in, capped, and shows its cost
before and after.

## Behaviour

### Enablement

`ai.review.enabled` (default false) gates every review. While it is false no review button is shown, the session
band and the digest footer show a dismissable "Enable reviews for better insights" nudge linking to Settings, and
`POST /api/sessions/:id/review` returns `409 reviews_disabled`. `ai.review.auto` (default false) additionally gates
automatic reviews.

### Triggers

1. **Click.** "Review this session (~$x.xx)" in the session's review band calls `POST /api/sessions/:id/review`.
   "Review all (~$x.xx)" in the Overview digest footer starts a server-side job (`POST /api/reviews/run`) that reviews
   eligible sessions one at a time.
2. **Auto.** At the end of `enrichSession()`, after the session lock is released, when reviews and auto-review are
   on and the session is auto-eligible (see Eligibility). Catch-up summaries and `enrich` with AI off never review.
3. No other path runs a review.

### Eligibility

`reviewEligibility()` decides. A session is **eligible** when reviews are on, it has ended (a `SessionEnd` event, or
no new line for 24 hours), it has not been reviewed, and it crosses a threshold:

- turns > `ai.review.autoThreshold.turns` (default 20), or
- non-cached tokens (input + cache creation + output) > `ai.review.autoThreshold.tokens` (default 200,000), or
- a Tier 1 finding of severity `high` whose rule is not demoted. Tier 2 findings never count.

It is **auto-eligible** when it is also hook-captured (not imported) and `ai.review.auto` is on. Reasons returned when
not: `reviews_disabled`, `open`, `below_threshold`, `reviewed`, `auto_off`, `imported`.

A click needs only reviews on and an ended session; the threshold does not apply.

### Review run (`reviewSession`)

1. **Lock.** Take the `review-<session_id>` lock without waiting (separate from the ingest and enrich lock). If it is
   held, return `busy` (`409 review_in_flight`).
2. **Checks.** The session must have ended (`409 session_open`); an auto run must be auto-eligible.
3. **Cap.** Count today's `ai_calls` rows with feature `review` (local day). At or above `ai.review.maxPerDay`
   (default 10) the run is refused (`429 review_cap_reached` on click, skipped on auto). `runClaude()` re-checks the
   cap atomically when it reserves the `ai_calls` row, so two concurrent clicks cannot both take the last slot. The
   cap covers clicks and auto runs and is separate from `ai.maxPerDay`.
4. **Prompt.** `buildReviewPrompt()` assembles fixed instructions, the session's Tier 1 findings (rule, message,
   evidence), the AI summary when there is one, the repo's existing task labels, and the stored-turns transcript from
   [06](06-ai-session-summary.md) (≤ 60,000 characters). Task labels (`repoTaskLabels()`) are the repo's previous
   review `task_pattern` values, most recent first, then the labels of its `repo_skill` patterns (not fingerprint
   labels), deduplicated by normalized form, at most 30, so the model reuses them. Turn numbers in the result are the
   transcript's "Turn N", the N-th turn of the session by `seq`. Reviews never resume or fork the user's session.
5. **Call.** `runClaude({ prompt, schema: REVIEW_SCHEMA, feature: "review", model: ai.model, cap })`. Every call runs
   with no tools and no MCP servers (`--tools "" --strict-mcp-config`), a `--max-budget-usd 0.50` ceiling, and a
   180-second timeout; `runClaude()` prepends the `[cc-debrief:review]` sentinel line. One call, never retried.
6. **Validate** with zod (`ReviewResultSchema`). Over-long strings are cut rather than rejected, because a rejection
   would spend a review with no retry: goals and goal-change `from`/`to` 300 characters, friction `note` 500,
   `what_went_well` 1,000, `better_approach` 1,500, `suggested_first_prompt` 2,000, `task_pattern` 80; at most 10
   goals, 10 goal changes and 20 friction entries. A result that still fails is an error with reason `schema: …`.
7. **Store.** Redact the result, then in one transaction upsert `reviews` (one row per session; a re-review replaces
   it) and the Tier 2 findings. `cost_usd` is `ClaudeResult.costUsd`, the call's own usage priced with the price
   table. Tokens and cost also go to `self_usage` with feature `review` ([15](15-self-usage-tracking.md)).
8. Return the actual cost; the UI replaces the estimate with it.

### Estimate

`estimateReviewCost()` takes the context as `ceil(prompt characters / 4)` tokens. Once 5 or more review calls exist
in `self_usage`, it uses their median cost per 1,000 context tokens (schema failures included, since they paid for the
same context). Before that it prices the context as uncached input plus 1,500 output tokens on `ai.model`, else the
session's last model. It is `null` ("cost unknown") when no priceable model is known.

### Review schema (`schema_version = 1`)

```json
{
  "goals": ["string"],
  "goal_changes": [{ "turn": 4, "from": "string", "to": "string" }],
  "friction": [{ "turn": 7, "kind": "ambiguous_ask | missing_context | scope_creep | wrong_tool | agent_confusion", "note": "string" }],
  "what_went_well": "string",
  "better_approach": "string, 2-3 sentences, concrete",
  "suggested_first_prompt": "string",
  "task_pattern": "string, short canonical label, reused from the repo's existing labels when one fits",
  "confidence": "low | medium | high"
}
```

### Findings from a review

- **`goal_drift`** (severity medium, one per session): produced when the review lists more than two goals or any goal
  change. With a change at turn t inside the session, `costTokens` is the tokens of turns t to the end and the
  message reads "{n} goals: {goal 1} (turns 1–{t−1}), then "{to}" at turn {t} — {tokens} tokens on the later goal(s);
  one session per goal, `/clear` between". With a change turn outside the session the turn is left out and the cost
  is 0. With more than two goals and no change, `costTokens` = session tokens × (n − 1) ÷ n and the message lists the
  goals.
- **`review_friction`** (severity low, one per friction entry, subject `turn:<n>:<kind>`): `costTokens` is that
  turn's tokens (0 outside the session). Message "{Kind label}[ at turn n]: {note}", with labels Ambiguous ask,
  Missing context, Scope creep, Wrong tool, Agent confusion.
- Every Tier 2 finding stores `evidence.confidence`; with `low` it is shown collapsed in the band.
- `task_pattern` is not a finding; it feeds [10 — Repeat-pattern detection](10-repeat-pattern-detection.md).

### Feedback

Per-finding helpful / not-helpful and the 30-day dismiss work as for Tier 1 ([09](09-weekly-coaching-digest.md)).
"Was this useful? Yes / No" on a review (`POST /api/sessions/:id/review/feedback`) applies to that review's own Tier 2
findings only, counts one vote per rule with the same switching rules, and is stored on `reviews.feedback` even when
the review produced no findings.

### Review all

`POST /api/reviews/run` with `{ scope: "eligible_7d" }` queues every eligible, unreviewed session started in the last
7 days (`eligibleReviewIds()`), oldest first, and returns `{ queued, estUsd }`. Only one job runs at a time
(`409 job_running`). It stops on `capped` or `disabled`, or after 3 consecutive errors; a busy session counts as done.
Progress is in `GET /api/status` → `reviewJob`.

## Data

| Table | Access | Notes |
| --- | --- | --- |
| `reviews` | read, write | id, session_id (unique), schema_version, result JSON, cost_usd, model, created_at, feedback, agent (`007_reviews.sql`) |
| `findings` | write | `goal_drift`, `review_friction` rows |
| `ai_calls` | read, write via `runClaude()` | Daily cap ledger |
| `self_usage` | read, write via `runClaude()` | Actual consumption; past costs for the estimate |
| `rule_feedback` | read | Demoted rules are excluded from the threshold |
| `sessions`, `turns`, `usage`, `events`, `patterns` | read | Thresholds, prompt, estimate, task labels |

## Interfaces

- `src/coach/review.ts`: `reviewSession(db, sessionId, cfg, { trigger: "auto" | "click" })` →
  `ReviewOutcome = { status: "done" | "capped" | "disabled" | "busy" | "open" | "skipped" | "error"; costUsd?; reason?; reviewId? }`;
  `estimateReviewCost()`, `buildReviewPrompt()`, `reviewEligibility()`, `reviewFindings()`, `eligibleReviewIds()`,
  `estimateReviewAll()`, `REVIEW_SCHEMA`, `ReviewResultSchema`, `TIER2_RULES`.
- `src/coach/review-band.ts`: `sessionReviewBand()` builds the band returned with the session detail.
- `src/coach/feedback.ts`: `recordReviewFeedback()`.
- `src/claude/headless.ts`: `runClaude()`; `src/server/jobs.ts`: `startReviewJob()`.
- API:

  | Method and path | Response |
  | --- | --- |
  | `POST /api/sessions/:id/review` | `{ reviewId, costUsd, band }`; `404 not_found`; `409 reviews_disabled` / `review_in_flight` / `session_open`; `429 review_cap_reached`; `502 review_failed` with the reason |
  | `POST /api/sessions/:id/review/feedback` body `{ value: "helpful" \| "not_helpful" }` | `{ demoted: string[] }`; `400 bad_request`; `404 not_found` (no review) |
  | `POST /api/reviews/run` body `{ scope: "eligible_7d" }` | `{ queued, estUsd }`; `409 job_running` / `reviews_disabled`; `422 invalid_body` |
  | `GET /api/sessions/:id` | Includes the review band with findings, Tier 2 content and the estimate |
  | `GET /api/sessions` | Each list item's `review` (`none` / `eligible` / `reviewed` with the estimate), null while reviews are off |
  | `GET /api/improvements` | Digest footer: reviews this week, their cost, eligible-unreviewed count and estimate |

- Config: `ai.review.enabled`, `ai.review.auto`, `ai.review.autoThreshold.turns`, `ai.review.autoThreshold.tokens`,
  `ai.review.maxPerDay`, `ai.model` ([16 — Settings](16-settings.md)). For example
  `cc-debrief config set ai.review.enabled true`.

## UI

- **Session review band.** Header "Session review", then "reviewed · cost $0.14 · confidence high" on a reviewed
  session, a "Review this session (~$0.18)" or "Review again (~$0.18)" button ("cost unknown" without an estimate;
  disabled with "daily cap reached" when the cap is used), and "Dismiss 30d". While a review runs (the click, or any
  worker holding the lock) it reads "Reviewing… up to 3 min"; after success the actual cost replaces the estimate; a
  failure shows "Review failed: <reason>" inline. A reviewed band has two columns: the findings (low-confidence ones
  under "Low-confidence findings (n)"), and "Better approach:", "Went well:", "Suggested first prompt" with a Copy
  button, and "Was this useful? Yes / No".
- **Sessions list.** An eligible row shows "Review (~$0.18)" as text; clicking the row opens the session, whose band
  has the button.
- **Overview digest footer.** "Reviews this week: N · $cost · M dismissed", "K eligible sessions not reviewed" and
  "Review all (~$x)", which asks for confirmation and then shows "Reviewing i of K…" ([09](09-weekly-coaching-digest.md)).
- **Sidebar.** Status line "AI: summaries on · reviews off".
- **Settings.** Toggles for reviews and auto-review, the thresholds and the daily cap ([16](16-settings.md)).

## Edge cases and failure modes

- `claude` missing, non-zero exit, timeout or budget exceeded: status `error`, the reason is shown on the band, nothing
  is written to `reviews`; the `ai_calls` row counts toward the cap and any cost is recorded in `self_usage`.
- Output fails validation: status `error` (`schema: …`); cost still recorded.
- Turn numbers outside the session: the finding is kept and the turn reference dropped from the message.
- Session still open: auto never runs; a click returns `409 session_open` until `SessionEnd`, or until the transcript
  has had no new line for 24 hours. Auto-review never runs on imported sessions.
- A demoted rule's high finding is the only threshold crossed: not eligible.
- Double click or "Review all" overlapping a click: the per-session lock allows one review at a time.
- Transcript file already deleted by Claude Code: no effect; reviews run from stored turns.
- The review's own `claude -p` session is ignored by the hook, skipped by ingest, and never counted in `sessions`.
- Windows: same spawn rules as summaries ([06](06-ai-session-summary.md)).

## Dependencies

- Depends on: [02 — Token and cost tracking](02-token-cost-tracking.md), [06 — AI session summary](06-ai-session-summary.md),
  [07 — Session review, Tier 1](07-session-review-tier1.md), [09 — Weekly coaching digest](09-weekly-coaching-digest.md),
  [15 — Self-usage tracking](15-self-usage-tracking.md), [16 — Settings](16-settings.md).
- Used by: [10 — Repeat-pattern detection](10-repeat-pattern-detection.md), [11 — Skill and CLAUDE.md suggestions](11-skill-claudemd-suggestions.md),
  [12 — Dashboard](12-dashboard.md).

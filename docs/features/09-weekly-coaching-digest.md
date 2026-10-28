# 09 — Weekly coaching digest

**Code:** `src/coach/digest.ts`, `src/coach/digest-rules/`, `src/coach/feedback.ts`, `src/db/queries/improvements.ts`

## Purpose

Findings are only useful if the developer sees the few that matter. The digest collects every finding in the
selected range and shows the three with the largest measured cost on the Overview, with helpful / not-helpful
feedback and a 30-day dismiss. Apart from a session's own detail page, it is the only place findings appear, so it is
also the main defence against nagging.

## Behaviour

### Inputs

The digest ranks rows of the `findings` table, written by:

1. Tier 1 signals ([07](07-session-review-tier1.md)), per session.
2. Tier 2 reviews ([08](08-session-review-tier2.md)): `goal_drift`, `review_friction`.
3. Pattern detection: `repeat_pattern` and `test_gap` ([10](10-repeat-pattern-detection.md)) and
   `skill_not_triggering` ([11](11-skill-claudemd-suggestions.md)).
4. The digest rules below.

### Digest rules

`runDigestRules()` runs each rule in `DIGEST_RULES` on `cc-debrief dashboard` start, after the Tier 1 re-check.
Rules read across sessions and write findings with `session_id = NULL`. Rows are upserted by (rule, subject), so a
subject's `feedback` survives every recompute; subjects no longer produced are deleted unless they carry feedback.
Each subject's dismissal, kept in `meta` as `dismiss:<rule>:<subject>`, is then copied onto the row as
`dismissed_until` when it is in the future and cleared otherwise. A rule that throws is logged to `coach-errors.log`
and keeps its previous rows.

Every finding is dated (`created_at`) by when it happened, so the 7-day range holds this week's events: a session
finding by its session's last activity, `cache_hit_dip` and `spend_spike` by their day, other digest-rule findings by
the run that computed them.

| Rule | Window | Fires when | Example message | `cost_tokens` | Target |
| --- | --- | --- | --- | --- | --- |
| `unused_skill` | 30 days | A skill loaded in ≥ 80% of its scope's sessions and invoked in none | "`pdf` loaded in 42 of 42 sessions, never invoked · ~480 tokens per session" | `estimateContextTokens(description)` × sessions loaded | skills |
| `unused_mcp` | 30 days | An MCP server with 0 `tool_calls` | "MCP server `neo4j` configured, 0 calls in 30 days · 12 tool schemas" | schema count × 150 × sessions that loaded it | skills |
| `cache_hit_dip` | 30 days | A local day whose cache-read share is more than 15 points below the median day | "Thu cache hit 54% vs usual 78% · 6 sessions over 2 h without compaction" | (median − share) × that day's input-side tokens | overview |
| `model_mix` | 7 days | Exploration sessions on the most expensive model used in the window | "5 exploration sessions on Opus = 31% of cost" | Those sessions' non-cached tokens | session (Sessions list filtered to exploration) |
| `tool_failure_hotspot` | 7 days | The same tool key fails ≥ 3 times in one repo | "`Bash: pytest` failed 14 times in `billing-api` this week" | Non-cached tokens of the turns with those failures | repos |
| `spend_spike` | 7 days | A local day whose spend is ≥ 2× the median of the previous 14 days with spend, and ≥ $5 | "Tue cost $42.10 vs usual $11.80 a day" | That day's tokens | Costs view |
| `budget_over` | month | The month's projected spend reaches `budget.monthlyUsd` | "On pace for $420 this month, over the $300 budget" | Month-to-date tokens | Costs view |

Rule notes:

- **Scope.** A skill or MCP server is measured against sessions started in the last 30 days; a repo-scoped item only
  against that repo's sessions. Items the last inventory scan no longer saw are skipped.
- **`unused_mcp` schemas.** Counted from the deferred-tool listing in the newest loaded sessions' transcripts (at most
  5 read); when none names the server's tools, 10 is assumed and the message says "(estimated)".
- **`model_mix`.** "Most expensive" = highest input price in the price table among models used in the window; the
  percentage is those sessions' share of the window's cost.
- **`tool_failure_hotspot`.** The key is `<tool>: <command key>` for shell tools ([07](07-session-review-tier1.md)),
  else the tool name. Only calls in sessions with a repo count.
- **Spend rules.** `spend_spike` uses the Costs view's per-day spend; both spend rules link to `/costs`
  ([18](18-activity-costs-budget.md)). `budget_over` has one finding per month (subject `YYYY-MM`).
- Severity is low for every digest rule except `budget_over` (medium).

### Building the digest

`buildDigest()` runs on each `GET /api/improvements` request:

1. Load findings whose `created_at` is in the range (default 7 days, rolling, ending now) and, with a repo filter,
   whose `repo_id` matches.
2. Drop findings with `dismissed_until > now`, and session-less findings whose `meta` dismissal is in the future.
3. Group findings into items: the same `rule` and the same repo (or no repo) form one item. Pattern findings
   (`repeat_pattern`, `test_gap`, `skill_not_triggering`) are the exception: each is its own item, so two repeated
   tasks in one repo are two suggestions. An item's cost is the sum of `cost_tokens`; its representative finding is
   the costliest one.
4. Leave out items with no cost. Sort non-demoted rules before demoted ones, then by summed cost (descending), highest
   severity, and newest finding.
5. Return the first three items and the footer.

An item that groups several sessions reads "{Label} in {n} sessions[ in `repo`]", for example "Goal drift in 4
sessions"; a single finding keeps its own message. Each item carries an `href` to the view that resolves it, its
stored vote, and, for a `repeat_pattern` item whose pattern is a skill candidate, an inline draft action with its
estimate ([11](11-skill-claudemd-suggestions.md)).

### Feedback and demotion

1. Helpful / not-helpful on an item calls `POST /api/findings/:id/feedback` with the representative id. The server
   applies it to the finding's group: findings with the same rule and repo created within 30 days of it, not
   dismissed.
2. `recordFeedback()` sets `findings.feedback` on every finding in the group and counts **one vote per action** in
   `rule_feedback`: +1 to the chosen counter, and −1 from the other when the group had the opposite vote before. Repeating
   the same vote counts 0.
3. When a rule's not-helpful count since its last re-enable reaches 3, the rule is demoted (`rule_feedback.demoted = 1`).
   Helpful votes do not offset not-helpful ones.
4. A demoted rule's items sort after all others, and its high findings no longer count toward the Tier 2
   auto-review threshold ([08](08-session-review-tier2.md)). Demotion changes rank, not visibility.
5. A demoted rule is re-enabled from Settings (`POST /api/findings/rules/:rule/enable`), which resets its counters.
6. "Was this useful?" on a Tier 2 review is a separate action on that review's own findings
   ([08](08-session-review-tier2.md)).

### Dismiss

`POST /api/findings/:id/dismiss` sets `dismissed_until = now + 30 days` on every finding in the group and writes the
`meta` key for its session-less members, so digest-rule findings stay dismissed after recomputation. With
`{ scope: "session" }` (the review band's "Dismiss 30d") it dismisses every finding of that session instead.

### Footer

The footer always covers the rolling 7 days, whatever the range:

- "Reviews this week: N · $cost · M dismissed": N = reviews created in the 7 days, cost = their summed `cost_usd`
  (shown when N > 0), M = findings created in the 7 days that are dismissed now.
- "K eligible sessions not reviewed" (when K > 0) with "Review all (~$x)": sessions started in the 7 days that
  `reviewEligibility()` calls eligible. The estimate is null ("cost unknown") when any session's estimate is unknown.
  Imported sessions count, since they can be reviewed by click.
- The self-usage line from [15](15-self-usage-tracking.md), then a Settings link.
- When `ai.review.enabled` is false, the reviews lines are replaced by the dismissable "Enable reviews for better
  insights" nudge.

## Data

| Table | Access | Notes |
| --- | --- | --- |
| `findings` | read, write (digest rules), update (feedback, dismiss) | Digest-rule rows have `session_id` NULL; `subject_key` = `evidence.key` |
| `rule_feedback` | read, write | rule (PK), helpful, not_helpful, demoted, updated_at, agent (`004_findings.sql`) |
| `meta` | read, write | `dismiss:<rule>:<subject>` → ISO date; `nudge.overview.dismissed_at` |
| `inventory`, `inventory_usage`, `transcript_lines` | read | `unused_skill`, `unused_mcp` |
| `usage`, `sessions`, `tool_calls`, `compactions`, `repos` | read | Other rules |
| `reviews`, `self_usage` | read | Footer |

## Interfaces

```ts
// src/coach/digest.ts
export const DIGEST_COST_FLOOR_TOKENS = 50_000;          // also the pattern-candidate floor (10)
export const DIGEST_RULES: DigestRule[];                 // the seven rules above
export function runDigestRules(db: Db, now?: Date): number;
export function buildDigest(db: Db, opts: { range: Range; repo?: string }): { items: DigestItem[]; footer: DigestFooter };

// src/coach/feedback.ts
export function recordFeedback(db: Db, findingId: number, value: "helpful" | "not_helpful"): { demoted: boolean };
export function dismissFinding(db: Db, findingId: number, days?: number): string;          // dismissed_until
export function dismissSessionFindings(db: Db, findingId: number, days?: number): string;
export function enableRule(db: Db, rule: string): void;
export function isDemoted(db: Db, rule: string): boolean;
```

`DigestItem` is `{ id, rule, severity, message, costTokens, sessionCount, repoId, target, href, demoted, collapsed,
feedback, action }`. `DigestFooter` is `{ reviewsThisWeek, reviewCostUsd, dismissed, eligibleUnreviewed,
estReviewAllUsd, reviewsEnabled, nudgeDismissed, selfUsage }`. Exact types are in `src/server/types.ts`.

| Method and path | Response |
| --- | --- |
| `GET /api/improvements?range&repo` | `{ items: DigestItem[]; footer: DigestFooter }` |
| `GET /api/findings?range&repo&session` | `{ findings: FindingRow[] }`; range defaults to 7 days, or all time with `session` |
| `POST /api/findings/:id/feedback` body `{ value }` | `{ ok: true; demoted: boolean }` |
| `POST /api/findings/:id/dismiss` body `{ scope?: "group" \| "session" }` | `{ ok: true; dismissedUntil: string }` |
| `POST /api/findings/rules/:rule/enable` | `{ ok: true }`; `404` for an unknown rule |

Unknown finding ids return `404 not_found`; invalid bodies `400 bad_request`.

## UI

Overview, a card beside the tokens chart titled "This week's coaching digest", ranked by cost. Each of up to three
rows has a colour dot (one colour for Tier 1 and Tier 2 findings, another for pattern suggestions), the message
linking to the item's `href`, a muted "≈ N tokens" line, an optional inline action such as "Draft skill (~$0.20)",
helpful / not-helpful buttons that start from the stored vote, and a Dismiss control. The footer follows (see
Footer). With no qualifying findings the card reads "No costly patterns this week". Demoted rules are listed in
Settings with a re-enable control ([16](16-settings.md)).

## Edge cases and failure modes

- Fewer than three items: show what exists; zero-cost findings never pad the list.
- Range "today": items come from today's findings only; the footer still covers 7 days.
- All items demoted: they still show, in cost order.
- A finding whose session was purged by retention is deleted with it; digest-rule findings are recomputed.
- A digest rule fails: it is skipped and logged; the other rules still run.
- The eligible-unreviewed count uses the Tier 2 threshold even when `ai.review.auto` is off.

## Dependencies

[02 — Token and cost tracking](02-token-cost-tracking.md), [05 — Inventory scan](05-inventory-scan.md),
[07 — Session review, Tier 1](07-session-review-tier1.md), [08 — Session review, Tier 2](08-session-review-tier2.md),
[10 — Repeat-pattern detection](10-repeat-pattern-detection.md), [11 — Skill and CLAUDE.md suggestions](11-skill-claudemd-suggestions.md),
[12 — Dashboard](12-dashboard.md), [15 — Self-usage tracking](15-self-usage-tracking.md), [16 — Settings](16-settings.md),
[18 — Activity, costs and budget](18-activity-costs-budget.md).

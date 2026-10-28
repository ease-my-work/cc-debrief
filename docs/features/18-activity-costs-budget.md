# 18 — Activity, costs and budget

**Code:** `src/db/queries/activity.ts`, `src/db/queries/costs.ts`, `src/db/queries/budget.ts`, `src/coach/digest-rules/budget-over.ts`, `src/coach/digest-rules/spend-spike.ts`, `ui/src/routes/Activity.tsx`, `ui/src/routes/Costs.tsx`

## Purpose

The Overview answers "what happened this week". This feature answers the longer questions: how often and when you work with Claude Code, what it costs over months, which models and repos the money goes to, whether you are on pace for a monthly budget, and whether a day was unusual. Everything is read from tables the tracker already fills, so it keeps working after Claude Code deletes old transcripts.

## Behaviour

### Activity view (`/activity`)

- **Heatmap:** the last 365 local days ending today, one cell per day, shaded by sessions started that day. A day with sessions shows "N sessions · X tokens"; days before the oldest retained session are hatched and marked "not retained".
- **Streaks:** current = consecutive days with at least one session, ending today; while today has none yet, the run ending yesterday still counts. Longest = the longest run among retained days. Days are local calendar days, so a DST change never splits or merges one.
- **Range stats** (follow the range select): active days, sessions by hour of day (0–23) and by weekday, both by local session start, and the share of sessions with at least one compaction.
- With the `all` range and retention longer than a year, the view notes that the heatmap shows only the last 365 days.

### Costs view (`/costs`)

- **Cost per day**, stacked by model. Each session's cost is spread over the times of its usage, so a long session lands on the days it ran. With `all`, the chart shows the newest 366 days and notes how much spend falls before them.
- **Cost by repo** (sessions outside a repo show as "no repo") and a **per-model table** of input, cache write, cache read and output tokens with cost. Models missing from the price table ([02](02-token-cost-tracking.md)) are counted and shown as "not priced"; they never get a guessed price.
- **Cache hit rate** = cache reads ÷ (input + cache write + cache read). **Cache savings** = per model, cache-read tokens × (input price − cache-read price), over counted usage rows only (reported totals carry no per-token rates).
- **Run rate:** sessions started in the last 30 days, whatever the range, at API prices, as a monthly figure: "Last 30 days at API prices: ≈ $X/month. Pro $20 · Max 5x $100 · Max 20x $200 (prices as of <date>)". It is information only: it raises no finding and never says which plan you have.
- Totals equal the Overview tiles for the same range and repo. The tracker's own `claude -p` calls are not included; they are in self-usage ([15](15-self-usage-tracking.md)).

### Monthly budget

- Set with `budget.monthlyUsd` (default `null` = off; [16](16-settings.md)). The month is the local calendar month; spend is the cost of your sessions started in it (session totals, so sessions with a reported cost count at Claude Code's own figure).
- Projection = month-to-date ÷ days elapsed (today included) × days in the month. On day 1 this is today's spend × days in the month, so it is noisy early in a month.
- Level: `warn` when the projection reaches 80% of the budget, `over` at 100%, else `ok`.
- A band on Overview and Costs, coloured by level: "$X of $B this month · on pace for $P · N days left" (at `over`: "on pace for $P, over the $B budget").
- At `over`, one digest item per month ([09](09-weekly-coaching-digest.md)): rule `budget_over`, severity medium, "On pace for $P this month, over the $B budget".

### Spend spike (digest rule `spend_spike`)

- For each local day in the last 7: the day's spend (spread the same way as the cost chart) is at least 2× the median of the 14 active days (days with spend) before it, and at least $5. Fewer than 14 earlier active days within 180 days: no finding.
- Severity low, one item per day: "<Weekday> cost $X vs usual $M a day", with that day's tokens.
- Dismiss and feedback work as for the other digest items.

The terminal digest (`cc-debrief digest`, [13](13-cli.md)) prints the same budget pace, spikes and cache hit rate.

## Data

Reads `sessions`, `usage`, `compactions`, `repos` and `events`. No table of its own; `budget.monthlyUsd` and `pricing.overrides` live in `config.json`.

## Interfaces

| Method and path | Purpose |
| --- | --- |
| `GET /api/activity?range=today\|7d\|30d\|90d\|all` (default `30d`) | Heatmap, streaks and range stats (`getActivity()`) |
| `GET /api/costs?range=…&repo=<id>` (default `30d`) | Cost per day, by repo, by model, cache figures, run rate and budget (`getCosts()`, `getBudget()`) |

The budget band on Overview comes from the overview response. Full response types are in `src/server/types.ts` and [architecture.md](../architecture.md).

## UI

"Activity" and "Costs" sit in the sidebar after Overview. Both take the range select (today, 7d, 30d, 90d, all); Costs also takes the repo filter.

## Edge cases and failure modes

- Empty database: Activity shows "No sessions yet"; Costs shows "No cost yet" and no run-rate line.
- A session with only unpriced-model usage adds tokens but no cost.
- A budget set mid-month: the projection uses the whole month so far, not the time since it was set.
- A user with few active days: spike detection stays silent until there are 14 earlier active days.

## Dependencies

[02 — Token and cost tracking](02-token-cost-tracking.md), [09 — Weekly coaching digest](09-weekly-coaching-digest.md), [12 — Dashboard](12-dashboard.md), [13 — CLI](13-cli.md), [15 — Self-usage tracking](15-self-usage-tracking.md), [16 — Settings](16-settings.md).

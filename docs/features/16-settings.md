# 16 — Settings

**Code:** `src/config.ts` (schema, load, update), `src/capture-config.ts` (the hook's fast reader), `src/commands/config.ts`, `src/server/routes/config.ts`, `ui/src/routes/Settings.tsx`

## Purpose

Every AI feature spends the user's plan usage, and the capture settings decide what sensitive text is stored and for how long. One file, `~/.cc-debrief/config.json`, holds all settings. The CLI (`cc-debrief config`) and the dashboard's Settings page both edit it. Settings also owns the dismissable nudge that suggests enabling reviews.

## Config keys

| Key | Type | Default | Valid values | Effect |
| --- | --- | --- | --- | --- |
| `ai.summaries.enabled` | boolean | `true` | | AI summary for each finished session with at least 2 turns; when off, sessions get a heuristic type only ([06](06-ai-session-summary.md)) |
| `ai.maxPerDay` | integer | `50` | 0–1,000 | Summaries per local calendar day; the rest stay pending until the next day; `0` means none |
| `ai.review.enabled` | boolean | `false` | | Allows Tier 2 reviews ([08](08-session-review-tier2.md)). When off, the review button is replaced by the nudge and `POST /api/sessions/:id/review` returns `409 reviews_disabled` |
| `ai.review.auto` | boolean | `false` | | Auto-review sessions over the threshold. Works only while `ai.review.enabled` is true; setting it while reviews are off succeeds with a warning |
| `ai.review.autoThreshold` | `{ turns, tokens }` | `{ "turns": 20, "tokens": 200000 }` | turns 1–10,000; tokens 1,000–100,000,000 | A session qualifies for auto-review, and counts as "eligible" in the digest, when turns > `turns`, or non-cached tokens (input + cache write + output) > `tokens`, or it has a high-severity session-check finding from a rule that is not demoted |
| `ai.review.maxPerDay` | integer | `10` | 0–1,000 | Tier 2 reviews per local calendar day, auto and manual combined |
| `ai.drafts.enabled` | boolean | `false` | | Allows AI skill drafts and "Widen description"; deterministic CLAUDE.md suggestions work regardless ([11](11-skill-claudemd-suggestions.md)) |
| `ai.model` | string, optional | unset (Claude Code's default) | 1–100 chars, `^[A-Za-z0-9][A-Za-z0-9._:\[\]-]*$` | Passed as `--model` to every internal `claude -p` call; cost estimates use its price |
| `capture.redact` | string[] | `["@default"]` | at most 200 entries; each `@default`, a regex body or `/body/flags`, and must compile | Redaction patterns; `@default` expands to the built-in list ([14](14-local-only-privacy.md)). New captures only |
| `capture.maxFieldBytes` | integer | `32768` | 1,024–1,048,576 | Cap per stored text field. The fixed 8 KB tool-result and 1 KB hook-output cuts are not affected. New captures only |
| `capture.permissionHook` | boolean | `true` | | Records approved permission prompts through the `PermissionRequest` hook, for the permission-friction finding ([07](07-session-review-tier1.md)). Turning it off stops recording at once; the hook entry stays in `settings.json` until you run `cc-debrief init` |
| `retention.days` | integer | `90` | 0–3,650 | Retention window for automatic retention and `purge`; `0` keeps data forever |
| `recap.hiddenRepos` | string[] | `[]` | at most 200 entries, each 1–200 chars | Repo names or ids left out of every work recap, copy and polish prompt ([17](17-work-recap.md)); names that match no repo are kept |
| `budget.monthlyUsd` | number or null | `null` | null or 0.01–1,000,000 | Monthly budget for the band on Overview and Costs and the `budget_over` digest item ([18](18-activity-costs-budget.md)); null turns it off |
| `pricing.overrides` | object | `{}` | keys: model id or family, 1–100 chars; values `{ input, output, cacheWrite?, cacheWrite1h?, cacheRead? }`, each 0–10,000 $ per million tokens | Merged over the built-in price table ([02](02-token-cost-tracking.md)); a change re-prices stored usage |
| `dashboard.port` | integer | `4242` | 1,024–65,535 | Port for `cc-debrief dashboard`; `--port` overrides it for one run. Applies on next start |
| `dashboard.pollSeconds` | integer | `15` | 0 or 5–300 | How often a running dashboard reads changed transcripts; `0` turns it off. Applies on next start |

Related state that is not a config key: demoted coaching rules live in `rule_feedback` ([09](09-weekly-coaching-digest.md)); finding and nudge dismissals live in `meta`.

## Config file

1. Location: `<data dir>/config.json`, mode `0600` on POSIX.
2. The file is sparse: it holds only the keys you set. Values are merged over the schema defaults, so new defaults in later versions apply automatically.
3. Missing file: all defaults. A key with an invalid value falls back to its default, and the error is shown by `doctor` and in a banner on the Settings page. A file that is not valid JSON gives all defaults and blocks writes until it is fixed or deleted.
4. Unknown keys are kept on write and otherwise ignored; `doctor` warns about them.
5. Every write re-reads the file, applies the change, validates the result, and writes atomically (temp file, then rename). Any invalid change rejects the whole write. Invalid values elsewhere in the file do not block an unrelated change.
6. The hook reads only the `capture.*` keys, with a minimal reader that falls back to defaults on any problem. The dashboard reads the file per request, so a change made from the CLI shows on the next page load.

Example `config.json`:

```json
{
  "ai": {
    "review": { "enabled": true, "maxPerDay": 5, "autoThreshold": { "turns": 30, "tokens": 300000 } },
    "model": "haiku"
  },
  "capture": {
    "redact": ["@default", "/\\bACME-[0-9A-F]{32}\\b/g"]
  },
  "retention": { "days": 60 }
}
```

## CLI

`cc-debrief config get [key]` prints the effective config, or one dotted key, as JSON. `cc-debrief config set <key> <value>` parses `true`/`false` as booleans, `null` as null, numbers as numbers, text starting with `[` or `{` as JSON, and anything else as a string. An empty string removes the key so its default applies. An object key (such as `ai.review.autoThreshold`) can be set whole as JSON, or one leaf at a time. Unknown key or invalid value: exit 2, nothing written ([13](13-cli.md)).

```text
$ cc-debrief config set ai.review.autoThreshold.turns 30
ai.review.autoThreshold.turns = 30   (was 20)
$ cc-debrief config set capture.redact '["@default","/\\bACME-[0-9A-F]{32}\\b/g"]'
capture.redact = ["@default","/\\bACME-[0-9A-F]{32}\\b/g"]   (was ["@default"])
$ cc-debrief config set ai.model ""
ai.model unset (Claude Code default)
$ cc-debrief config set capture.permissionHook false
capture.permissionHook = false   (was true)
Permission prompts are no longer recorded. Run `cc-debrief init` to remove the hook entry as well.
$ cc-debrief config set budget.monthlyUsd null
budget.monthlyUsd = null   (was 150)
$ cc-debrief config set retention.days -1
error: retention.days must be an integer between 0 and 3650
```

## Settings page

Reached from the sidebar at `/settings`. Each control saves on its own through `PUT /api/config`; there is no global Save button. The server validates the whole config and returns the new config or per-field errors, shown under the control.

- **AI features:** session summaries toggle and summaries per day (with "N used today" and the pending count); Tier 2 reviews toggle and reviews per day; auto-review toggle with turns and tokens inputs; skill drafts toggle; model for tracker calls; demoted coaching rules with "Re-enable". Turning on reviews, auto-review or drafts first shows the estimated cost per call (from the feature's recent `self_usage` cost, or the price table when there is no history) and asks to confirm; turning one off saves at once. Auto-review and its inputs are disabled while reviews are off.
- **Capture & retention:** the redaction list, where the built-in patterns are one row that can be removed or restored, custom patterns can be added or removed, a pattern that does not compile is refused before saving, and a Test box shows sample text after redaction (using the same `src/redact.ts` code); record permission prompts toggle (after a change, a note to run `cc-debrief init`); max field size; retention days with a size estimate, where lowering the value first shows how many sessions the next retention run will delete; dashboard port and live refresh seconds ("apply on next start"); the data directory with database size and Claude Code's transcript folder size; the `purge` and `uninit` commands to copy; "Show tips again".
- **Recap** (`/settings#recap`): one checkbox per repo for `recap.hiddenRepos` (repos with sessions in the last 30 days, plus any hidden name that matches no listed repo, so it can be unchecked), with the note: "Hiding a repo removes its sessions and files from the recap. It cannot remove words about that work from a session title or summary in another repo."
- **Budget:** monthly budget field, with a clear button.
- **Pricing:** the price-table date, built-in rows, override rows with edit and remove, progress while sessions are re-priced, and a note that reported totals keep Claude Code's own cost.
- **Tracker usage:** the 7 / 30 day table of the tracker's own calls ([15](15-self-usage-tracking.md)).
- A banner at the top when `config.json` has errors, naming the file and the invalid keys.

## Reviews nudge

- "Enable reviews for better insights", with an "Enable reviews" link and a close button. Shown only while `ai.review.enabled` is false, in the Overview digest footer and the session review band.
- The link opens Settings at the reviews toggle; it does not enable anything by itself.
- Closing stores `meta` key `nudge.<overview|session>.dismissed_at`; the nudge then stays hidden in that place until "Show tips again" clears the keys.

## Interfaces

```ts
// src/config.ts
export const ConfigSchema: z.ZodType<Config>;
export function loadConfig(): Config;
export function getConfigValue(key: string): unknown;               // dotted key; ConfigError if unknown
export function setConfigValue(key: string, raw: string): Config;   // CLI value syntax, validates, writes
export function updateConfig(patch: { set?: Record<string, unknown>; unset?: string[] }): Config;
export function configErrors(): { key: string; message: string }[];
```

| Method and path | Response |
| --- | --- |
| `GET /api/config` | `{ config, defaults, explicit, path, errors, defaultRedactCount, demotedRules, usedToday: { summaries, reviews }, pendingSummaries, estimates: { summaryUsd, reviewUsd, draftUsd }, dataDir, dbBytes, storage, pricing }` |
| `PUT /api/config` body `{ set?: Record<string, unknown>; unset?: string[] }` | `200 { config, changed }`, or `422 { error: { code: "invalid_config", message, fields: { key, message }[] } }` (an unknown key is a field error; a malformed body has no fields) |
| `GET /api/config/retention-preview?days=<n>` | `{ sessions }`: how many sessions the next retention run would delete with that value |
| `GET /api/self-usage?range=7d\|30d` | `SelfUsage` ([15](15-self-usage-tracking.md)) |
| `POST /api/nudges/:name/dismiss` (`overview` or `session`) | `{ ok: true }` |
| `POST /api/nudges/reset` | `{ ok: true }` |
| `POST /api/findings/rules/:rule/enable` | `{ ok: true }` ([09](09-weekly-coaching-digest.md)) |

## Edge cases and failure modes

- `config.json` edited by hand while the dashboard is open: the next request reads the new file; a save re-reads the file before writing, so the hand edit is kept.
- `ai.model` set to a model `claude` rejects: the next summary fails, the session records the error, and `doctor` names the rejected model.
- Daily cap reached: further summaries stay pending until the next day; review buttons say the cap is reached. The cap is enforced where the call is spawned, so parallel workers cannot exceed it ([15](15-self-usage-tracking.md)).
- An invalid regex added to `capture.redact` by hand: that pattern is skipped, the others still apply, and `doctor` warns.
- `dashboard.port` already in use: `dashboard` exits 1 with a hint; the config is not changed.
- `capture.permissionHook` and the installed hooks disagree: `doctor` reports it (a missing `PermissionRequest` entry fails, a leftover one warns) and names `cc-debrief init` as the fix.
- A slow hook (for example antivirus scanning Node): `doctor` times one hook run and suggests turning `capture.permissionHook` off above 150 ms.

## Dependencies

[02 — Token and cost tracking](02-token-cost-tracking.md), [06 — AI session summary](06-ai-session-summary.md), [08 — Session review, Tier 2](08-session-review-tier2.md), [09 — Weekly coaching digest](09-weekly-coaching-digest.md), [11 — Skill and CLAUDE.md suggestions](11-skill-claudemd-suggestions.md), [12 — Dashboard](12-dashboard.md), [13 — CLI](13-cli.md), [14 — Local-only and privacy](14-local-only-privacy.md), [15 — Self-usage tracking](15-self-usage-tracking.md), [17 — Work recap](17-work-recap.md), [18 — Activity, costs and budget](18-activity-costs-budget.md).

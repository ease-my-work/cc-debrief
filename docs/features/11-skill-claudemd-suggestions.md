# 11 — Skill and CLAUDE.md suggestions

**Code:** `src/patterns/draft.ts`, `src/patterns/context.ts`, `src/patterns/kept-lines.ts`, `src/patterns/install.ts`, `src/patterns/adoption.ts`, `src/patterns/views.ts`

## Purpose

A detected repeat pattern ([10](10-repeat-pattern-detection.md)) is only useful once it becomes something Claude Code
loads: a repo skill, a user skill, a CLAUDE.md rule or a pointer paragraph. This feature drafts that artifact from the
sessions that did the work, lets the developer edit it in the dashboard, installs it only on an explicit click, and
then measures whether it is used and whether it made matching sessions cheaper or faster.

## Behaviour

### Suggestion by kind

| `patterns.kind` | Suggestion | Draft method |
| --- | --- | --- |
| `repo_skill` | `.claude/skills/<name>/SKILL.md` in the repo | `claude -p` (feature `draft`) |
| `user_skill` | `<claudeDir()>/skills/<name>/SKILL.md` | `claude -p` (feature `draft`) |
| `claude_md_rule` | One rule line appended to the repo's `CLAUDE.md`, or a file in `.claude/rules/` | Deterministic; optional "Rewrite with Claude" (mode `rewrite_rule`) |
| `claude_md_pointer` | A paragraph in `CLAUDE.md` naming the files read at session start | Deterministic |
| `test_gap` | None; finding only | Drafting and install refuse it |

**Deterministic drafts** cost nothing and work even when `ai.drafts.enabled` is false. A rule draft is one line from
the most central correction (`ruleLine()`: "use httpx not requests" → "Use httpx, not requests."; other sentences are
capitalized and end with a full stop). A pointer draft is "Most sessions in this repo start by reading these files;
read them first:" followed by one bullet per file. Deterministic drafts always target `CLAUDE.md`; only a "Rewrite with
Claude" draft can target `.claude/rules/<slug>.md`.

### Draft flow (skills)

1. **Estimate.** Candidates show "Draft skill (~$X)". The estimate prices `ceil(prompt characters ÷ 4)` input tokens
   plus 2,000 output tokens on `ai.model`, else the user's most-used model; null ("cost unknown") without a priceable
   model. It counts every added line without asking git, so it is an upper bound. An installed skill is estimated in
   mode `widen`, a rule in mode `rewrite_rule`.
2. **Gate.** With `ai.drafts.enabled` false the button becomes "Enable skill drafts in Settings" and
   `POST /api/patterns/:id/draft` returns `409 drafts_disabled` without spawning anything.
3. **Context.** `buildDraftContext()` collects, per matched session, newest first: the first prompt (≤ 600
   characters), the AI summary (AI-written summaries only), the `toolSkeleton()`, and the added lines that were kept, grouped by file (≤ 40 per
   file, then "… N more"). `keptAddedLines()` takes added lines from the edit calls (`structuredPatch` `+` lines, else
   the input), ignores lines under 4 non-blank characters and truncation markers, and keeps those that appear among the
   `+` lines of `git log --all --since=<started_at> -p -- <paths>`, so squash-merged work still matches. When git
   cannot tell (no root, repo gone, git error), every added line is used and marked "unverified" in the prompt. The
   context is capped at 60,000 characters by dropping the oldest sessions. Mode `widen` sends only the current
   description and the first prompts of matching sessions that did not invoke the skill; mode `rewrite_rule` sends the
   pattern's correction sentences.
4. **Call.** `runClaude({ feature: "draft", prompt, schema: DRAFT_SCHEMA, model: ai.model, timeoutMs: 180_000 })`,
   with the same no-tools, no-MCP and budget limits as reviews ([08](08-session-review-tier2.md)). Output schema:

   ```json
   { "name": "kebab-case string", "description": "string, written to trigger on the observed prompts",
     "body": "markdown: when to use, steps that worked, checks to run at the end",
     "rule_text": "string or null", "target_file": "CLAUDE.md | .claude/rules/<name>.md | null" }
   ```

   `DraftResultSchema` trims strings and cuts over-long ones instead of rejecting them (`name` 200, `description`
   1,024, `body` 40,000, `rule_text` 1,000, `target_file` 200 characters; empty optional fields become null; extra
   keys are dropped), then the result is redacted. A result that fails the schema is an error (`502 draft_failed`).
5. **Write.** The draft goes to `~/.cc-debrief/drafts/<repo name slug, or user>/<slug>/SKILL.md` (front matter `name`
   and `description`, then the body) with a `draft.json` recording `{ patternId, sessions, costUsd, model, mode,
   createdAt, targetFile? }`. Rules and pointers are written as `RULE.md`. A pattern reuses its own draft directory;
   another pattern's directory with the same slug gets `-2`, `-3`. Files are `0600` and directories `0700` on POSIX.
   A `candidate` (or `dismissed`) pattern becomes `drafted`; `drafted` and `installed` keep their status.
   `patterns.draft_path` is set and any earlier draft error cleared.
6. **Edit.** The dashboard opens the draft in an editor. Saving (`PUT /api/patterns/:id/draft`) rewrites the draft
   file only, after validation: a `SKILL.md` needs plain-YAML front matter with a kebab-case `name` (≤ 64 characters)
   and a non-empty `description`; a `RULE.md` must not be empty. Otherwise `422 invalid_draft`. Front matter is always
   read with the inventory's YAML-only parser, never one that can execute embedded code.
7. **Cost.** The actual cost (`ClaudeResult.costUsd`) is shown after the call and recorded in `self_usage`
   ([15](15-self-usage-tracking.md)). Drafts have no daily cap; each one needs a click.

### Install (only on click)

1. "Install to repo" ("Install for me" for a user skill) calls `POST /api/patterns/:id/install`. No other path writes
   into a repo or into `claudeDir()`.
2. `resolveInstallTarget()` picks the file: for `repo_skill`, `<repo root>/.claude/skills/<name>/SKILL.md`; for
   `user_skill`, `<claudeDir()>/skills/<name>/SKILL.md`, where `<name>` is the draft's validated front-matter `name`;
   for rules and pointers, `draft.json`'s `targetFile` under the repo root (`CLAUDE.md` is appended to,
   `.claude/rules/<slug>.md` is created); for a `widen` draft, the installed skill's own `SKILL.md`, whose description
   is replaced. `GET /api/patterns/:id/draft` returns this path as `target`, so the confirm step names the exact file.
3. **Refusals** (`409` with the reason as the error code, nothing written): `repo_missing` (the repo root is gone, or
   the pattern has no repo), `target_exists` (the skill directory or rule file exists), `invalid_draft` (no draft,
   invalid front matter, a test gap, or the skill to widen is gone), `unsafe_target`. Names are slugified to
   `[a-z0-9-]` (≤ 64 characters) and `target_file` can only be `CLAUDE.md` or `.claude/rules/<slug>.md`. Every existing
   path segment from the root down is checked: a symlink (or Windows junction), or a segment whose real path falls
   outside the root's real path, is `unsafe_target`. The check runs again after new directories are made.
4. **Writes.** New files use the exclusive-create flag, so an existing file is never overwritten. Appends to
   `CLAUDE.md` keep the existing bytes, add a blank line before the rule, and end with a newline; a missing or empty
   `CLAUDE.md` is created with the rule. `<claudeDir()>/skills` is created when missing. The tracker never commits.
5. **Link.** After a skill install, the repo (or user) inventory is rescanned, `patterns.inventory_id` is set to the
   new skill's `inventory` row, `installed_at = now` and `status = 'installed'`. A widen install keeps the original
   `installed_at` and link. Rules and pointers keep `inventory_id` NULL and adoption is not measured.
6. The response lists the absolute paths written.

### Closing the loop

`adoptionStats()` reports, for each installed skill pattern:

- **Invoked since install:** `tool_calls` with `skill_name = <name>` in sessions started at or after `installed_at`
  (for a repo skill, sessions of that repo). Null without a linked skill row.
- **Before / after:** median non-cached session tokens and median duration of the pattern's sessions before install
  versus after. After-values appear only once ≥ 2 matching sessions exist after install; otherwise "—". For a pattern
  not yet installed, "before" is the median over all its sessions. The change is `round((after − before) / before × 100)`%.
- **Removed:** the linked skill row's `last_seen` is older than the scope's last scan (`meta` `last_scan_repo:<repo_id>`
  or `last_scan_user`), or the row is gone. Status stays `installed`.
- **Not triggering:** `checkInstalledPatterns()` (dashboard start, after detection) gives an installed skill that is
  not removed, was installed ≥ 14 days ago, has 0 invocations and ≥ 1 matching session since install a session-less
  finding `skill_not_triggering` (severity low, subject `pattern:<id>`, target `skills`, cost = tokens of the matching
  sessions since install): "`<skill>` skill not triggering — description too narrow: 0 invocations in N days while
  the task came back M time(s)". The finding is removed once the skill no longer qualifies.
- **Widen description:** `draftPattern(db, id, { mode: "widen" })` asks only for a revised `description`. The draft
  is the current `SKILL.md` (the installed file, else the pattern's own draft) with only the front-matter
  `description` replaced; installing it replaces only that field in the installed file.

## Data

| Table / path | Access | Notes |
| --- | --- | --- |
| `patterns` | read, update | status, draft_path, inventory_id, installed_at, meta.error |
| `sessions`, `turns`, `tool_calls`, `file_changes`, `usage` | read | Draft context, adoption, before/after |
| `inventory` | read, write via rescan | Link after install |
| `findings` | write | `skill_not_triggering` |
| `self_usage`, `ai_calls` | write via `runClaude()` | Draft cost |
| `meta` | read | `last_scan_*` for "removed" |
| `~/.cc-debrief/drafts/<repo or user>/<slug>/` | write | `SKILL.md` or `RULE.md`, `draft.json` |

## Interfaces

```ts
// src/patterns/draft.ts
export const DRAFT_SCHEMA: object;                         // JSON Schema for --json-schema
export const DraftResultSchema: z.ZodType<DraftOutput>;    // trims, cuts over-long text
export function estimateDraftCost(db: Db, patternId: number, cfg: Config,
  mode?: "create" | "widen" | "rewrite_rule"): number | null;
export function draftPattern(db: Db, patternId: number, cfg: Config,
  opts?: { mode?: "create" | "widen" | "rewrite_rule"; timeoutMs?: number }): Promise<DraftResult>;
export function draftDeterministic(db: Db, patternId: number): { draftPath: string };
export function readDraft(patternId: number, db: Db): { path: string; content: string };
export function saveDraft(db: Db, patternId: number, content: string): void;   // throws InvalidDraftError
// src/patterns/install.ts
export function installDraft(db: Db, patternId: number): { written: string[]; inventoryId: number | null };
// src/patterns/adoption.ts
export function adoptionStats(db: Db, patternId: number): Adoption;
export function checkInstalledPatterns(db: Db): number;
```

API (`src/server/routes/patterns.ts`; errors are `{ error: { code, message } }`; an unknown pattern is `404 not_found`):

| Method and path | Response |
| --- | --- |
| `POST /api/patterns/:id/draft` body `{ mode?: "create" \| "widen" \| "rewrite_rule" }` | `{ draftPath, costUsd, estUsd }`; `409 drafts_disabled`; `409 invalid_draft` (nothing to draft); `502 draft_failed` |
| `POST /api/patterns/:id/draft-rule` | `{ draftPath }`: the free deterministic `RULE.md` for rules and pointers; works with drafts off; `409 invalid_draft` for other kinds |
| `GET /api/patterns/:id/draft` | `{ path, content, target }` (`target` = the file Install would write, or null); `404` without a draft |
| `PUT /api/patterns/:id/draft` body `{ content }` (≤ 200,000 characters) | `{ ok: true }`; `422 invalid_draft` |
| `POST /api/patterns/:id/install` | `{ written: string[]; inventoryId }`; `409 target_exists` / `repo_missing` / `invalid_draft` / `unsafe_target` |
| `GET /api/inventory?kind=skill` | Includes `proposed: ProposedSkill[]` for the Skills & Tools table |

Config: `ai.drafts.enabled` (default false), `ai.model`.

## UI

- **Repos view, "Repeated work · suggestions"** ([10](10-repeat-pattern-detection.md)):
  - A skill candidate has "Draft skill (~$0.20)" ("Drafting… up to 3 min" while it runs, then "Drafted · cost $x")
    and Dismiss; with drafts off the button is the "Enable skill drafts in Settings" link.
  - A drafted skill shows a "drafted" badge, "draft ready in `drafts/billing-api/alembic-column/`", "Review draft"
    (opens the editor) and "Install to repo" / "Install for me", which first confirms the exact file and afterwards
    lists the paths written.
  - An installed card shows an "installed" badge and no buttons.
  - A rule card reads "Corrected by you in 3 sessions · ≈ 40k tokens" with "Add to CLAUDE.md", which makes the free
    draft and previews the exact text and target ("Appends after a blank line to `<repo>/CLAUDE.md`", or "Creates
    `<file>`") before Append / Create. "Rewrite with Claude (~$)" shows for rules when drafts are on. A pointer card
    reads "Read at the start of N sessions: a, b".
  - A failed draft's error shows on the card, also after a reload.
- **Skills & Tools, "Skills proposed from repeated work"** (Skills tab, above the main table, when there are rows;
  installed first, then drafted, then candidates, each by tokens): proposed skill name and description, repo ("user"
  for a user skill), status badge ("installed 12d", plus "removed" when the skill is gone; "candidate"; "drafted"; a
  warning style for "installed 16d · 0 invoked"), invocations, median tokens per session ("82k → 51k −38%", or the
  before value alone with its session count), median duration ("34m → 19m"), and an action: "Draft (~$0.20)" for a
  candidate, "Review draft" (a link to the repo) for a drafted row, "Widen description (~$0.05)" for an installed
  skill with a "skill not triggering" finding.
- **Overview digest:** a `repeat_pattern` item whose pattern is a skill candidate carries an inline "Draft skill
  (~$0.20)" ([09](09-weekly-coaching-digest.md)).

## Edge cases and failure modes

- `claude -p` fails, times out or returns an invalid result: no automatic retry (a retry would double the cost without
  a click). The pattern keeps its status, the error (first 200 characters, `schema: …` for an invalid result) is
  stored in `patterns.meta.error` and shown on the card, and the button shows again. A call that ran is still recorded
  in `self_usage`.
- Invalid model `name`: slugified to kebab-case; if empty, the label's slug, else `skill`.
- A dismissed pattern drafted through the API becomes `drafted`.
- The user edits the installed skill later: adoption keeps tracking by name; the next scan updates the description.
- The user deletes the installed skill: the next scan marks it gone; the pattern stays `installed` and shows "removed".
- The repo is on another branch at install time: install writes to the working tree as it is.
- A cross-repo `user_skill` installs under `claudeDir()`, never into a repo.

## Dependencies

[05 — Inventory scan](05-inventory-scan.md), [06 — AI session summary](06-ai-session-summary.md),
[08 — Session review, Tier 2](08-session-review-tier2.md), [09 — Weekly coaching digest](09-weekly-coaching-digest.md),
[10 — Repeat-pattern detection](10-repeat-pattern-detection.md), [12 — Dashboard](12-dashboard.md),
[15 — Self-usage tracking](15-self-usage-tracking.md), [16 — Settings](16-settings.md).

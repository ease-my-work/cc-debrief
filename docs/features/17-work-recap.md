# 17 — Work recap

**Code:** `src/recap/` (range, build, format, polish), `src/db/queries/recap.ts`, `src/commands/recap.ts`, `src/server/routes/recap.ts`, `ui/src/routes/Recap.tsx`

## Purpose

By standup time, or at the end of a sprint, a developer rarely remembers what they worked on, but their Claude Code sessions recorded it. The recap lists the work for any range (a day, a week or a custom range), grouped by repo, ready to paste as plain text or Markdown, from the CLI or the dashboard. The default output makes no AI call. An opt-in "Polish with AI" action rewrites it into tighter standup prose with one `claude -p` call.

The recap is a read-only view over tables the tracker already fills. It never contains prompt text or directories, and hidden repos are removed before anything else.

## Ranges

All days are local calendar days, inclusive, in the machine's time zone. Both ends of a range sit at local midnight, so a DST day is 23 or 25 hours long. Future dates are allowed and give an empty recap.

| CLI | API | Range |
| --- | --- | --- |
| none, `--today` | none, `range=today` | today |
| `--yesterday` | `range=yesterday` | yesterday |
| `--date <YYYY-MM-DD>` | `date=` | that day |
| `--week` | `range=week` | today and the 6 days before it |
| `--from <YYYY-MM-DD>` [`--to <YYYY-MM-DD>`] | `from=`, `to=` | from–to; `to` defaults to today |

Invalid input is rejected with these messages (CLI: `error: <message>`, exit 2; API: `400 invalid_range`):

| Input | Message |
| --- | --- |
| Malformed or impossible date (`2026-02-30`) | `invalid date "<x>"` |
| `from` after `to` | `from is after to` |
| More than 366 days | `range longer than 366 days` |
| More than one range input, or `to` without `from` | `use one of --today, --yesterday, --date, --week, --from` |

## Which sessions count

A session appears on a day when it has a turn that started on that local day, and the session as a whole has at least 2 turns or at least one file change. A session that spans midnight appears on each day it had turns. Open sessions count with what has been ingested so far. The tracker's own `claude -p` sessions never appear ([15](15-self-usage-tracking.md)).

## Repo grouping

1. Sessions are grouped by repo ([04](04-repo-file-attribution.md)) and labelled with the repo name.
2. **Agent worktrees fold into their parent.** A repo with a remote already shares one id across worktrees. For a repo without a remote whose root contains a `/.claude/worktrees/<name>` segment, sessions are grouped under the repo at the path before that segment, when one exists. Other remote-less `git worktree` checkouts stay separate, named after their folder.
3. A session with no repo is grouped under the base name of its working directory, or `no repo` when that is unknown too.
4. Repos are ordered by turns in range, busiest first, then by name.
5. **Hidden repos** (`recap.hiddenRepos`, matched case-insensitively against repo name or id) are removed first: from grouping, counts, copy and the polish prompt. A worktree folded into a hidden parent is hidden too. A folded worktree can also be hidden on its own, which hides only its sessions. Edits to files in a hidden repo are dropped from every bullet.
6. A group's `repoId` is set only for a repo with a network remote. For other repos the id is a local path, and no output may contain a directory, so it is null.

## Bullets

One bullet per session (per session-day when grouped by day). The text comes from the first source with a non-blank value:

| # | Source | Example | `source` |
| --- | --- | --- | --- |
| 1 | Session title: the last `custom-title` line in the main transcript (desktop app, `/rename`), else the last `ai-title` line (CLI and VS Code) | "Add rate limiting to the public endpoints" | `title` |
| 2 | First sentence of the AI summary ([06](06-ai-session-summary.md)), leading `-`, `*`, `"` trimmed, cut after the first `.`, `!` or `?` followed by a space | "Added a token-bucket limiter to the gateway." | `summary` |
| 3 | Agent name: the last `agent-name` line | "Feat/ingest-worker ingest" | `agent_name` |
| 4 | Files edited, most-changed first: 3 named, then `+N` | "errors.go, gateway_test.go, handlers.go +1" | `files` |
| 5 | Nothing edited: files read, most-read first: 2 named, then `+N` | "read backend.tf, iam.tf +5" | `explored` |
| 6 | Nothing edited or read | "Explored billing-api" | `explored` |

- Whitespace is collapsed. Paths in a title, summary or agent name are cut to their base name when rooted (`/x`, `C:\x`, `~/x`) or with two or more separators (`src/recap/build.ts` → `build.ts`); a single relative separator (`Feat/ingest-worker`) and URLs are left alone.
- Text longer than 120 characters is cut at a word boundary so that it plus `…` fits in 120.
- Bullets never contain prompt text (`turns.user_text`), and nothing else in the recap does either.
- **Duplicates:** within a repo group (and day, when grouped by day), bullets with the same text after trimming and lower-casing are merged. The merged bullet keeps the first one's source and time, unions the files and keeps every session id.

## File line

Under each bullet, the files edited in that session, counting only edits whose tool call ran inside the range (and on that day, when grouped by day):

- Base names only, never a directory. A base name from two directories is shown once, with its churn summed.
- Ordered by lines added + removed, descending, then by name; 3 shown, then `+N`.
- Left out when the bullet's source is `files` (it already names them) or `explored`, and when files are turned off (`--no-files`, or the Files toggle).

## Grouping and formats

- **By repo** (default): one header for the range, then repo groups, then bullets in order of each session's first turn in range. A session with turns on two days is one bullet.
- **By day** (`--by-day`, `groupBy=day`): one section per day with work, oldest first, each with its own header and repo groups. Days without work are skipped.

Plain text (default):

```text
Mon, Sep 28 2026

billing-api
  • Add rate limiting to the public endpoints
    errors.go, gateway_test.go, handlers.go +1
  • Fix the flaky auth integration test

ingest-worker
  • Debug the failed webhook retry
    retry.ts, retry.test.ts, queue.ts +3
```

- A multi-day header reads `Tue, Sep 22 – Mon, Sep 28 2026`; day and month names are English.
- Markdown: `## <range or day>`, `### <repo>`, `- <bullet>`, and the file line as an indented item with each name in backticks; `\`, `` ` ``, `*` and `_` in bullet text are escaped.
- JSON (`--json`): the `Recap` object below.
- Lines end in `\n` on every platform, and the output never ends with a newline or a blank line, so it pastes cleanly.
- Empty range: `No work recorded for Mon, Sep 28 2026.` When the range starts before the retention cutoff, it adds ` (older than the 90-day retention window)` before the full stop, using `retention.days`.

## Polish with AI (opt-in)

`polishRecap()` makes one `claude -p` call with feature `recap` and the pinned `ai.model`, if any:

1. **Input:** fixed instructions plus the recap as JSON: repo labels, bullet texts, file base names, and the stored AI summaries of each bullet's sessions (with paths cut to base names). A by-day recap is merged into repo groups first. No prompts, no turn text, no transcript. Hidden repos are already gone.
2. **Output:** a concise standup-style list per repo, past tense, related items merged, no invented work, schema `{ "groups": [ { "repo": "string", "items": ["string"] } ] }`. Every `repo` must be one of the input labels; blank items and empty groups are dropped. An unknown label, a malformed result or nothing left is a `schema` failure.
3. **No retry and no daily cap:** every call is an explicit click or flag, and a retry would double the cost. Timeout 120 s. A failure throws `PolishError` (`polish failed: <reason>`, where the reason is `not_found`, `exit`, `timeout`, `parse`, `schema` or `budget`); the plain recap stays available.
4. **Empty recap:** no call is made and no estimate is shown.
5. **Cost estimate:** the mean cost of the last 10 recap calls once at least 3 have a cost; before that, the prompt's characters ÷ 4 as input tokens plus 600 output tokens, priced on `ai.model` or the most-used recent model. Null (shown as "cost unknown") when no model can be priced.
6. **Ledger:** one `ai_calls` and one `self_usage` row, like every internal call ([15](15-self-usage-tracking.md)).
7. **Not stored:** the polished text lives in the page or the CLI output; asking again makes a new call. It is rendered with the same formatters, without file lines.

Polish works whether or not `ai.summaries.enabled` is on. Without `claude` on PATH it fails with reason `not_found`.

## Freshness

`cc-debrief recap` reads new transcript lines first (no AI), so the current turn of an open session counts; `--no-ingest` skips this. The dashboard view relies on the dashboard's poll.

## Data

| Table | Use |
| --- | --- |
| `sessions` | repo_id, cwd, summary, title, agent_name (title and agent name are derived from the transcript's `custom-title`, `ai-title` and `agent-name` lines) |
| `turns` | started_at (which days a session counts on; the activity strip) |
| `file_changes`, `tool_calls` | edited files, churn and the time of each edit |
| `tool_calls` (`Read`) | files read, for `explored` bullets |
| `repos` | name, root path, remote (grouping, worktree folding) |
| `self_usage`, `ai_calls` | excluding internal sessions; polish estimate and ledger |
| `usage` | most-used recent model for the polish estimate |

## Interfaces

```ts
// src/recap/types.ts
type RecapRange = { from: string; to: string };                      // local dates YYYY-MM-DD, inclusive
type BulletSource = "title" | "summary" | "agent_name" | "files" | "explored";
type RecapBullet = { text: string; source: BulletSource; files: string[]; moreFiles: number;
  sessionIds: string[]; firstTurnAt: string };
type RecapGroup = { repo: string; repoId: string | null; turns: number; bullets: RecapBullet[] };
type RecapDay = { date: string; groups: RecapGroup[] };
type Recap = { range: RecapRange; groupBy: "repo" | "day";
  groups: RecapGroup[];                                              // groupBy "repo"; [] otherwise
  days: RecapDay[];                                                  // groupBy "day"; [] otherwise
  hiddenRepos: number;                                               // hidden groups that had work in range
  sessions: number;
  retentionCutoff: string | null; retentionDays: number;
  activity: { date: string; slots: number[] }[] };                   // 96 quarter-hour turn counts per day
type PolishedRecap = { range: RecapRange; groups: { repo: string; items: string[] }[];
  costUsd: number | null; model?: string };

// functions
resolveRange(input, now?): RecapRange                                // throws RecapRangeError
buildRecap(db, cfg, { range, groupBy, files, now? }): Recap
formatText(r), formatMarkdown(r), formatRepo(r, repo, "text" | "markdown")
polishRecap(db, recap, cfg): Promise<PolishedRecap>                  // throws PolishError
estimatePolishCost(db, recap, cfg): number | null
```

**CLI:** `cc-debrief recap`, see [13](13-cli.md) for flags and exit codes. `--polish` prints the estimate to stderr first; on failure it prints the plain recap, then `error: polish failed: <reason>`, and exits 1.

**API:**

| Method and path | Response |
| --- | --- |
| `GET /api/recap?range=today\|yesterday\|week&date&from&to&groupBy=repo\|day&files=1\|0` | `{ recap, text, markdown, repoText: Record<repo, { text, markdown }>, polishEstUsd }`; `400 invalid_range`, `400 bad_request`. Never calls `claude` |
| `POST /api/recap/polish` body `{ range?, date?, from?, to?, groupBy? }` | `{ polished, text, markdown }`; `400 invalid_range`, `400 bad_request`; `409 polish_in_flight` (one at a time); `502 { error: { code: "polish_failed", message, reason } }` |

**Config:** `recap.hiddenRepos` ([16](16-settings.md)).

## UI

The **Recap** view (`/recap`) in the sidebar:

- **Top bar:** Today / Yesterday / Week / Custom; on single-day ranges, buttons to step one day back or forward (not past today); By repo / By day; a Files checkbox. All choices live in the URL query (`range`, `date`, `from`, `to`, `groupBy=day`, `files=0`). Custom shows two date inputs and applies a date once it is complete.
- **Card:** the range heading (or one per day), each repo with a `×N` session count (when more than one) and a "Copy <repo>" button, and each bullet with its text (linking to the first session), the file line, and its start time. Times are view-only; the copied text has none.
- **End-of-day footer:** "END OF DAY" (or "N DAYS") with the item count, then an activity strip of the day's 96 quarter hours, each bar sized by its turn count (multi-day ranges sum by time of day), with a text label such as "Activity: 4h 15m active, 09:00–17:30" for screen readers.
- **Bullet source:** hovering or focusing a bullet shows where its text came from ("from session title", "from AI summary", "from agent name", "from edited files", "from files read") in a status line, with links to its sessions.
- **Actions:** "Copy text", "Copy Markdown" and "Polish with AI (~$0.01)" (or "cost unknown"). While polishing the card stays readable; afterwards it shows the polished version tagged with its actual cost, with a toggle back to the original. Copy buttons copy the version shown. A failure shows the reason inline and keeps the original. Changing the range or options discards the polished version.
- **Footer:** "6 sessions · 3 repos" and, when repos are hidden, "2 repos hidden · Settings" linking to `/settings#recap`.
- **Empty state:** "No work recorded for …" with a link to all sessions; no copy or polish buttons.

## Edge cases and failure modes

- A title line only in a subagent transcript: ignored; the main transcript decides.
- The title changes during a session: the last `custom-title` wins; without one, the last `ai-title`.
- No title, summary or agent name (a short CLI session, or an old Claude Code version): the bullet falls through to files or explored.
- A title containing `[REDACTED]`: shown as is; redaction ran at capture.
- A session purged by retention: absent. A range entirely before the retention cutoff is empty, with the retention note.
- A file edited in another repo than the session's: listed under the session's bullet, unless that repo is hidden.
- A clock or time-zone change between capture and recap: days are computed at recap time from UTC timestamps.
- `recap.hiddenRepos` names a repo that does not exist: accepted and kept, since the repo may appear later.
- Hiding a repo cannot remove words about that work from a title or summary in another repo; the Settings page says so.
- Polish invents a repo or returns nothing: `schema` failure, original kept.
- A clipboard that refuses the write leaves the copy button unchanged.

## Dependencies

[01 — Session capture](01-session-capture.md), [04 — Repo and file attribution](04-repo-file-attribution.md), [06 — AI session summary](06-ai-session-summary.md), [12 — Dashboard](12-dashboard.md), [13 — CLI](13-cli.md), [14 — Local-only and privacy](14-local-only-privacy.md), [15 — Self-usage tracking](15-self-usage-tracking.md), [16 — Settings](16-settings.md).

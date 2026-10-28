# 12 — Dashboard

**Code:** server `src/server/` (`app.ts`, `security.ts`, `routes/`), UI `ui/src/` (`app.tsx`, `routes/`, `components/`), command `src/commands/dashboard.ts`

## Purpose

The dashboard is the local web UI served by `cc-debrief dashboard`. It answers the everyday questions (what did Claude
Code cost me this week, which installed skills and servers do I never use, where did I solve this before, how is
Claude used in this repo, what happened in this session) and hosts the coaching surfaces: the digest, the session
review band and the repeated-work suggestions. It serves one developer on their own machine, has no authentication,
and so binds to `127.0.0.1` only.

## Server

1. `createApp(db, { port, uiDir })` builds a Hono app; `cc-debrief dashboard` serves it on `127.0.0.1` at
   `dashboard.port` (default 4242) or `--port`.
2. **Host check.** Any request whose `Host` is not exactly `127.0.0.1:<port>` or `localhost:<port>` gets
   `421 misdirected_request`. This blocks DNS-rebinding attacks.
3. **Origin check.** A `POST`, `PUT`, `PATCH` or `DELETE` gets `403` when its `Origin` is another site
   (`forbidden_origin`) or its body is not `application/json` (`unsupported_content_type`, which forces a CORS
   preflight the server never answers). This blocks cross-site request forgery. No CORS headers are ever sent.
4. `/api/*` routes are served from `src/server/routes/`; errors are `{ error: { code, message } }`. Other `GET` paths
   serve the prebuilt UI from `dist/ui`, falling back to `index.html` for client routes.
5. **Background work on start.** Tier 1 re-checks, digest rules and pattern detection run after the server is up
   ([07](07-session-review-tier1.md), [09](09-weekly-coaching-digest.md), [10](10-repeat-pattern-detection.md)).
6. **Live refresh.** Every `dashboard.pollSeconds` (default 15; `0` turns it off) the server ingests pending
   transcripts, skipping sessions whose lock is held ([01](01-session-capture.md)). The UI polls `GET /api/status`
   on the same interval and refetches the open view when `lastIngestAt` changes. A session with no `SessionEnd` event
   and a last line under 30 minutes old is **in progress**: it shows an "In progress" badge, its tokens and turns grow
   as new lines land, and it gets no summary, review or Tier 1 findings until it ends (or has no new line for 24
   hours).
7. The UI is React, Vite, Tailwind and Recharts, prebuilt into the package; the user never runs a frontend build.
   Fonts (IBM Plex Sans and Mono) are bundled, so the UI makes no request outside the dashboard origin.

## Navigation and filters

| Route | View | Documented in |
| --- | --- | --- |
| `/` | Overview | below, [09](09-weekly-coaching-digest.md) |
| `/activity` | Activity | [18](18-activity-costs-budget.md) |
| `/costs` | Costs | [18](18-activity-costs-budget.md) |
| `/sessions`, `/sessions/:id` | Sessions (list and detail) | below, [07](07-session-review-tier1.md), [08](08-session-review-tier2.md) |
| `/skills?tab=skills\|mcp\|tools\|plugins\|workspace` | Skills & Tools | below, [05](05-inventory-scan.md), [11](11-skill-claudemd-suggestions.md) |
| `/repos`, `/repos/:id` | Repos | below, [10](10-repeat-pattern-detection.md) |
| `/recap` | Recap | [17](17-work-recap.md) |
| `/tasks` | Tasks & plans | below |
| `/settings` | Settings | [16](16-settings.md) |

- **Sidebar.** Links in the order above, Settings at the foot, and a status line from `GET /api/status`: "AI:
  summaries on · reviews off", "Local only · last ingest 2 min ago", "N summaries pending" when there are any, and
  "Hooks off · run `cc-debrief init`" when hooks are not installed. While a history import runs, a thin progress bar
  reads "Importing history · 120/283".
- **Date range.** Today, 7 days, 30 days, 90 days or All (everything still retained); "today" starts at local
  midnight, the others are rolling windows ending now. Overview, Activity and Costs use a segmented control; the other
  views a dropdown. Defaults: Overview and Sessions 7 days, the rest 30 days. Day charts over "All" show at most the
  newest 366 days and say so.
- **Repo filter.** "All repos" on Overview, Costs, Sessions, Skills & Tools and Tasks & plans; the choice carries
  across views.
- Filters live in the URL query, so reloads and shared links keep them; the last choice is mirrored in
  `localStorage`.
- **Command palette.** Ctrl/Cmd-K searches views, sessions (prompt, summary, title; top 8), repos, skills and tools.
  Enter opens, Esc closes; focus is trapped and restored.
- **Keys** (ignored while typing in a field): `g` then `o` Overview, `a` Activity, `c` Costs, `s` Sessions, `r` Repos,
  `t` Tasks & plans, `k` Skills & Tools, `e` Settings; `j` / `k` move in lists and Enter opens; `/` focuses search;
  `?` lists the keys.
- **Theme.** Light and dark follow the OS `prefers-color-scheme`.

## Views

### Overview

- An optional budget band when a monthly budget is set ([18](18-activity-costs-budget.md)).
- Four tiles: **Sessions** (with the split by surface, for example "31 CLI · 9 VS Code · 2 desktop"), **Tokens**
  (with "% served from cache"), **Est. cost** (per model family, plus "N tokens unpriced" when some models have no
  price), **Code changed** (lines added and removed, "N files across M repos").
- Donuts: cost by model and sessions by repo (top 6 plus other).
- **Tokens per day**: stacked bars of input (cache writes included), cache read and output. Over "All" a caption says
  when older days are cut. The chart has an accessible label and a hidden data table. Cache-hit dips surface as
  digest items, not on the chart.
- **This week's coaching digest**: up to three items ranked by cost, with the footer ([09](09-weekly-coaching-digest.md)).
- **Recent sessions**: the last 5, with when, repo, type, summary, tokens and cost; rows open the session.

### Sessions

- **List.** Search box ("Search prompts and summaries": case-insensitive substring over prompts and summaries), repo,
  type and range filters. Header "42 sessions · 7 days". Each row shows repo, type badge (with "heuristic" when the
  type was not set by AI), time, a one-line summary (the session title, else the summary's first sentence, else the
  first prompt), and tokens · cost · duration · models. An eligible unreviewed session adds "Review (~$0.18)"
  ([08](08-session-review-tier2.md)). Infinite scroll, 50 per page. A banner offers to summarize imported sessions
  that have no summary ([06](06-ai-session-summary.md)).
- **Detail header.** Type badge, "In progress" when running, date, time span, surface and short session id; a
  "claude --resume" button copies `claude --resume <id>` to the clipboard (a browser cannot open a terminal). Below it,
  the AI summary with its outcome, or a state line ("Summary pending", "Summary failed: <reason>" with a
  "Summarize (~$0.02)" button, "Summaries are off", "No summary: fewer than 2 turns", "Summarized after the session
  ends").
- **Session review band.** Tier 1 and Tier 2 findings with feedback, dismiss and the review controls
  ([07](07-session-review-tier1.md), [08](08-session-review-tier2.md)).
- **Timeline.** Per turn: the prompt (long prompts collapse behind "more"), tool chips grouped by tool
  (`Grep ×4 · 2.1s`; red with "failed ×N" when calls failed; "denied ×N" for denials, which are not failures), and an
  assistant excerpt; compaction markers between turns. Turns after the first two sit behind a "N more turns…"
  expander.
- **Replay.** Switches the timeline to every turn's full stored reply rendered as Markdown (cut at 32 KB with a note),
  its tokens and cost, tools and failures; a cumulative-token curve; filters (tool calls, failures, compactions, top
  10% by cost); and find-in-session with next and previous. Markdown renders without raw HTML or images, links get
  `rel="noreferrer"`, and `javascript:` links are dropped.
- **Side facts.** Token breakdown (input, cache write, cache read, output, cost); files changed with `+N` per file
  (prefixed with the repo name when the session edited more than one repo); "Used" badges for skills, MCP servers,
  built-in tools and instruction files, with call counts and failures (`Read ×12`, `Bash ×5 · 2 failed`).

### Skills & Tools

- Tabs: **Skills**, **MCP servers**, **Built-in tools**, **Plugins & hooks**, **Workspace**; range and repo filters.
- **Summary strip** (Skills, MCP and plugin tabs): installed count by scope, invoked at least once in the range, never
  invoked ("still loaded into every session"), and the context cost of unused skills in tokens per session.
- **Skills proposed from repeated work** (Skills tab, when there are rows): see [11](11-skill-claudemd-suggestions.md).
- **Main table**, with "Show unused only". Skills: name and source, scope, loaded, invoked, invoked/loaded bar, last
  used, context tokens, status (active, unused 30d, never used), Remove. MCP servers: server, scope, tools, calls,
  failures, median ms, last used, status, Remove. Built-in tools: every tool ever called, with calls, failures,
  denials, median ms and sessions for the range and repo, last used all-time, and a category filter. Plugins & hooks:
  one table with a Kind column. Workspace: the other inventory kinds with a kind selector ([05](05-inventory-scan.md)).
- Feature adoption ("share of sessions") and Claude Code versions tables.
- **Remove** opens a popover with the file's absolute path, a copy button and how to remove the entry; nothing is
  deleted and no process is spawned. It is hidden for items with no local path. Removed items keep their history and
  show a "removed" badge.
- Status meanings: active = invoked in the last 30 days; unused 30d = invoked before but not in the last 30 days;
  never used = never invoked since first seen.

### Repos

- **Repo table** (range filter only): name with branch and branches seen, remote (`host/org/repo`, or "no remote"),
  sessions, tokens, cost, lines, repo skills used ("2 / 4") and repo MCP servers. Sessions outside a git repo are not
  listed. Selecting a row opens the repo's panels.
- **Trends**: languages, branches, skills / MCP servers / subagent types used here, top tools, and sessions and cost
  per week (Monday start).
- **Most edited files**: top 5 paths with session counts and lines, and the session-type mix.
- **Repo-level skills & MCP**: items from `.claude/skills`, `.mcp.json`, `.claude/settings.json` and CLAUDE.md, with
  usage badges ("22 invoked", "never", "31 calls", "loaded 61×"); lazy skills are labelled.
- **Repeated work · suggestions**: see [10](10-repeat-pattern-detection.md) and [11](11-skill-claudemd-suggestions.md).
- **Memory files**: the repo's Claude Code auto-memory files from `~/.claude/projects/<slug>/memory/`, read live and
  read-only, cut at 64 KB.

### Tasks & plans

Tasks from the newest `TaskCreate` / `TaskUpdate` / `TodoWrite` state of each session (subject, status, session,
repo, time), with a status filter (All, Pending, In progress, Completed) and search; plans from `ExitPlanMode` calls,
rendered as Markdown.

### Recap, Activity, Costs, Settings

- **Recap**: a copyable daily or weekly work summary ([17](17-work-recap.md)). It has its own range control and does
  not use the shared filters.
- **Activity** and **Costs**: activity heatmap and hour charts; spend over time, by model and by repo, and the budget
  ([18](18-activity-costs-budget.md)).
- **Settings**: AI features, capture, retention, pricing, demoted rules and self-usage ([15](15-self-usage-tracking.md),
  [16](16-settings.md)).

### Shared states and formatting

- First run with no sessions: "No sessions captured yet" with the `cc-debrief doctor` command. Loading: skeleton
  blocks at their final size. API failure: an inline error card with the message and a retry button; other panels
  keep working.
- Tokens compact (`3.8M`, `388k`); USD with two decimals; durations `1h 12m`; times `14:02` today, "Yesterday", the
  weekday within 7 days, else `26 Sep`; model ids as family names (`Opus → Sonnet` when a session switched);
  identifiers, numbers and paths in monospace; session ids shortened (`a3f9…c21e`).

## Data

The dashboard reads every derived table. It writes only through the coaching, pattern and config routes, and through
AI calls (summaries, reviews, drafts, recap polish), which write `ai_calls` and `self_usage`.

Derivations used across views:

- **Tokens** = input + output + cache creation + cache read from `usage`.
- **Cache served %** = cache read ÷ (input + cache creation + cache read).
- **Cost** = sum of `usage.cost_usd`; rows without a price (unknown model) are left out and counted as unpriced
  tokens. Session totals follow [02](02-token-cost-tracking.md) (shown with "≥" when partial, "tokens unknown" when
  there is no usage).
- **Duration** = `ended_at − started_at`; running sessions show "running".
- **Surface** from `sessions.surface` (`cli`, `vscode`, `desktop`, `unknown`).
- **Lines** from `file_changes`; files = distinct (repo, path); repos = distinct repo ids.

## API routes

Response types are in `src/server/types.ts`. Ranges are `today`, `7d`, `30d`, `90d` or `all`.

| Method and path | Purpose | Documented in |
| --- | --- | --- |
| `GET /api/status` | AI switches, last ingest and hook event, hooks installed, backfill / summary / review / Tier 1 job progress, in-progress count, poll interval, pending summaries, version | |
| `GET /api/overview?range&repo` | Tiles, donuts, tokens per day, chart note, budget, recent sessions | |
| `GET /api/improvements?range&repo` | Digest items and footer | [09](09-weekly-coaching-digest.md) |
| `GET /api/sessions?range&repo&type&q&cursor&limit` | Session list (50 per page, max 100) | |
| `GET /api/sessions/:id` | Session detail with the review band | |
| `GET /api/sessions/:id/replay` | Full replies for Replay | |
| `POST /api/sessions/:id/summarize`, `GET /api/summaries/estimate?since`, `POST /api/summaries/run` | Summaries | [06](06-ai-session-summary.md) |
| `POST /api/sessions/:id/review`, `POST /api/sessions/:id/review/feedback`, `POST /api/reviews/run` | Tier 2 reviews | [08](08-session-review-tier2.md) |
| `GET /api/findings`, `POST /api/findings/:id/feedback`, `POST /api/findings/:id/dismiss`, `POST /api/findings/rules/:rule/enable` | Findings | [09](09-weekly-coaching-digest.md) |
| `GET /api/inventory?kind&range&repo&unused`, `GET /api/tools?range&repo`, `GET /api/adoption`, `GET /api/versions` | Skills & Tools | [05](05-inventory-scan.md), [03](03-tool-mcp-skill-usage.md) |
| `GET /api/repos?range`, `GET /api/repos/:id?range`, `GET /api/repos/:id/memory`, `GET /api/repos/:id/memory/:name` | Repos | [04](04-repo-file-attribution.md) |
| `GET /api/patterns`, `POST /api/patterns/:id/dismiss` | Repeat patterns | [10](10-repeat-pattern-detection.md) |
| `POST /api/patterns/:id/draft`, `POST /api/patterns/:id/draft-rule`, `GET` / `PUT /api/patterns/:id/draft`, `POST /api/patterns/:id/install` | Drafts and install | [11](11-skill-claudemd-suggestions.md) |
| `GET /api/recap`, `POST /api/recap/polish` | Recap | [17](17-work-recap.md) |
| `GET /api/activity`, `GET /api/costs` | Activity and Costs | [18](18-activity-costs-budget.md) |
| `GET /api/tasks-plans?range&repo&status&q` | Tasks & plans | |
| `GET` / `PUT /api/config`, `GET /api/config/retention-preview?days`, `GET /api/self-usage`, `POST /api/nudges/:name/dismiss`, `POST /api/nudges/reset` | Settings and nudges | [15](15-self-usage-tracking.md), [16](16-settings.md) |

## Edge cases and failure modes

- Port in use: `dashboard` exits 1 with a message suggesting `--port` ([13](13-cli.md)).
- Request with another `Host` (a LAN IP, a rebinding domain): `421`, no data.
- Sessions without a repo: "—" in repo columns, not listed in Repos.
- Unknown model prices: cost shows "—" for that session; the cost tile adds "N tokens unpriced".
- Unparsable transcript: tokens show "unknown", not zero.
- A poll overlapping a hook-triggered ingest of the same session skips the locked session; the next poll shows it.
- `dashboard.pollSeconds = 0`: views change only on reload.
- Very long prompts: collapsed in the list and timeline; stored text is already capped at `capture.maxFieldBytes`.

## Dependencies

[01 — Session capture](01-session-capture.md), [02 — Token and cost tracking](02-token-cost-tracking.md),
[03 — Tool, MCP and skill usage](03-tool-mcp-skill-usage.md), [04 — Repo and file attribution](04-repo-file-attribution.md),
[05 — Inventory scan](05-inventory-scan.md), [06 — AI session summary](06-ai-session-summary.md),
[07 — Session review, Tier 1](07-session-review-tier1.md), [08 — Session review, Tier 2](08-session-review-tier2.md),
[09 — Weekly coaching digest](09-weekly-coaching-digest.md), [10 — Repeat-pattern detection](10-repeat-pattern-detection.md),
[11 — Skill and CLAUDE.md suggestions](11-skill-claudemd-suggestions.md), [13 — CLI](13-cli.md),
[14 — Local-only and privacy](14-local-only-privacy.md), [15 — Self-usage tracking](15-self-usage-tracking.md),
[16 — Settings](16-settings.md), [17 — Work recap](17-work-recap.md), [18 — Activity, costs and budget](18-activity-costs-budget.md).

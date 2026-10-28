# cc-debrief

[![npm](https://img.shields.io/npm/v/cc-debrief)](https://www.npmjs.com/package/cc-debrief)
[![ci](https://github.com/ease-my-work/cc-debrief/actions/workflows/ci.yml/badge.svg)](https://github.com/ease-my-work/cc-debrief/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/cc-debrief)](LICENSE)

A local session tracker for [Claude Code](https://claude.com/claude-code). It records every session you run in the
CLI, the VS Code extension or the desktop app: prompts, tool calls, failures, tokens, cost, the repos and files you
touched, the skills and MCP servers you used. It writes a short AI summary of each finished session and shows it all
in a dashboard on `127.0.0.1`. Everything stays on your machine.

You also get an activity heatmap, costs by model and repo, a monthly budget, full session replay, tool and feature
use, tasks and plans, a command palette and a terminal digest, all built from the tracker's own database so they keep
working after Claude Code cleans up old transcripts. On top of that, cc-debrief coaches: per-session findings, a
weekly digest, skill suggestions and a paste-ready work recap.

## Install

Requires Node.js 22.13 or newer (it uses the built-in `node:sqlite`) and Claude Code.

```bash
npx cc-debrief init
```

`init` does the following:

- Copies its hook and CLI into `~/.cc-debrief/bin/`, so the hooks keep working after npx clears its cache.
- Adds four hooks to `~/.claude/settings.json`: `SessionStart`, `Stop` (async), `PermissionRequest` and `SessionEnd`.
  It backs up the file first (`settings.json.cc-debrief-<time>.bak`), changes nothing else in it, and
  `cc-debrief uninit` restores the original bytes.
- Imports your existing transcripts, so the dashboard has history on day one. No AI is used for these.
- Turns on AI summaries for **new** sessions. Each finished session makes one `claude -p` call on your plan, at most
  50 a day. To turn them off:

```bash
npx cc-debrief config set ai.summaries.enabled false
```

Then open the dashboard:

```bash
npx cc-debrief dashboard
```

It serves on `http://127.0.0.1:4242` (`--port` to change, `--no-open` to skip the browser) and refreshes every 15
seconds while open. It also works without `init`, in read-only mode: you lose the exact git state at session start
and the permission-prompt counts.

## What you get

- **Overview:** sessions, tokens, estimated cost and lines changed for today, 7, 30 or 90 days or everything
  retained, by repo; cost-by-model and sessions-by-repo donuts; tokens per day; the monthly budget band; recent
  sessions; what the tracker itself spent this week.
- **Activity:** a 365-day heatmap, current and longest streaks, sessions by hour and weekday, the compacted share.
- **Costs:** cost per day by model, by repo and per model with token types, cache hit rate and savings, a monthly
  budget with its projection, and your API-price run rate next to the plan prices. Price overrides in Settings.
- **Sessions:** search over prompts and summaries, filters by repo and type, and a timeline per session with tool
  calls, failures, denials, subagents, compactions, files and the `claude --resume` command; a full replay with
  every reply as Markdown, per-turn tokens and cost, filters and find in session.
- **Skills & Tools:** installed skills, plugins, MCP servers, hooks, agents, commands, output styles, rules and
  workflows, with how often each was used and the ones you never use but load into every session; tool categories,
  feature adoption (plan mode, subagents, skills, MCP, web, auto mode) and Claude Code versions.
- **Repos:** per-repo sessions, cost, most edited files, instruction files, languages, branches, weekly trend and
  the repo's Claude Code memory files.
- **Tasks & plans:** the task lists and plans Claude Code made in your sessions, searchable.
- **Recap:** what you worked on today, yesterday, this week or any date range, grouped by repo, ready to paste into
  a standup. Hide repos you never want listed. "Polish with AI" is optional.
- **Coaching:** findings on each session (retry loops, failing tools, permission friction, context churn, long
  sessions without compaction, MCP servers you bypass and more), ranked by what they cost you, with the top three on
  the Overview. No AI is used for these.
- **Session reviews (opt-in):** a deeper AI review of a session; the button shows the estimated cost ("Review this
  session (~$0.18)"). Turn on with `config set ai.review.enabled true`; `ai.review.auto` reviews long sessions on its
  own.
- **Repeated work and skill drafts:** the Repos view spots prompts you keep repeating and suggests a skill for them.
  With `config set ai.drafts.enabled true` it drafts the skill for you to edit; nothing is installed until you click
  "Install for me" or "Install to repo".
- **Everywhere:** Ctrl/Cmd-K searches views, sessions, repos, skills and tools; `g` + a letter switches views.
- **Settings:** AI features and daily caps, the model for tracker calls, redaction patterns with a test box,
  retention, and a table of the tracker's own usage.

## Commands

| Command | What it does |
| --- | --- |
| `cc-debrief init [--no-backfill]` | Install the hooks and import existing transcripts |
| `cc-debrief uninit` | Remove the hooks (restores `settings.json`); keeps your data |
| `cc-debrief dashboard [--port <n>] [--no-open]` | Open the local dashboard |
| `cc-debrief doctor` | Check the install, hooks, database, config and capture health |
| `cc-debrief ingest [session_id] [--since <date>] [--all]` | Read new transcript lines now |
| `cc-debrief enrich [session_id] [--no-ai]` | Finish sessions: git end state, line counts, the AI summary |
| `cc-debrief enrich --ai --since <date>` | Also summarize imported sessions started after a date (prints the estimated cost first; daily cap applies) |
| `cc-debrief scan [path]` | Rescan installed skills, plugins, MCP servers and hooks |
| `cc-debrief config get [key]` / `config set <key> <value>` | Show or change settings |
| `cc-debrief export [--format json\|csv] [--out <path>] [--days <n>] [--repo <id>]` | Export sessions, usage and tool calls |
| `cc-debrief purge [--dry-run]` | Delete data older than `retention.days` now |
| `cc-debrief purge --all [--yes]` | Delete all tracked data (keeps `config.json`) |
| `cc-debrief rebuild [--reingest]` | Re-derive every session from the stored transcript lines |
| `cc-debrief recap [--today\|--yesterday\|--week\|--date <d>\|--from <d>] [--markdown\|--json] [--polish]` | What you worked on, by repo, ready to paste |
| `cc-debrief digest [--days 7\|30] [--format text\|md\|json] [--repo <id>]` | Spend, top repos, budget pace, spikes, cache hit rate and coaching, no AI |

Exit codes: `0` ok, `1` failure, `2` usage or invalid value, `3` `settings.json` could not be parsed (nothing written).

## Privacy

- **Where:** everything is in `~/.cc-debrief/` (`tracker.db`, `config.json`). On macOS and Linux the folder is
  `0700` and the files `0600`.
- **What:** a slimmed, compressed copy of each transcript (so sessions survive Claude Code's own transcript cleanup),
  plus what is derived from it, git commit ids and line counts, and the inventory of installed skills and servers.
  Nothing is ever written inside your repos.
- **Redaction:** before anything is stored, 13 built-in patterns replace API keys, tokens, private keys and
  passwords with `[REDACTED]`. Add your own in Settings or with
  `config set capture.redact '["@default","/ACME-[0-9A-F]{32}/g"]'`. Long fields are cut at 32 KB.
- **Network:** cc-debrief itself opens no connections. The dashboard listens on `127.0.0.1` only and refuses other
  hosts and cross-site requests. The only outside traffic is the `claude -p` summary calls, which run your own Claude
  Code and its login. Turn summaries off and nothing leaves your machine.
- **Retention:** data older than 90 days is deleted automatically (`config set retention.days <n>`; `0` keeps
  everything). `purge` and `purge --all` delete on demand.
- **Full removal:** `cc-debrief uninit`, then delete `~/.cc-debrief/`.

## Cost of AI features

A summary is one `claude -p` call right after the session ends. It sends the session's stored turns, with no tools
and no MCP servers, and never resumes your session; the call's own transcript is deleted afterwards. On Opus a
summary usually costs between 5 and 20 cents, and less on a smaller model (`config set ai.model <model>`). Limits and
visibility:

- `ai.maxPerDay` (default 50) caps summaries per local day; anything over the cap waits for the next day.
- Session reviews and skill drafts are off until you turn them on. Reviews have their own cap,
  `ai.review.maxPerDay` (default 10).
- Imported history is never summarized unless you ask (`enrich --ai --since`, or "Summarize" in the dashboard), and
  you see the estimated cost first.
- The tracker's own calls never appear as your sessions. Their tokens and cost are shown separately on the Overview
  ("This package used: …") and in Settings, per feature, for 7 and 30 days.
- `ai.model` pins a model for all of the tracker's calls.

## Platforms

CI runs every test on Windows, macOS and Linux.

- **Windows:** `claude` is found through `PATH` (`claude.cmd`). Antivirus that scans every Node start can slow the
  synchronous hooks; `doctor` times one run and suggests `config set capture.permissionHook false` above 150 ms.
- **Config locations:** `CLAUDE_CONFIG_DIR` is honoured (default `~/.claude`). `CC_DEBRIEF_HOME` moves the data
  folder.

## Troubleshooting

Run `cc-debrief doctor`. It reports `PASS`, `WARN` or `FAIL` for Node, `claude` on `PATH`, the hook entries, the
hook's run time, the database, the config, transcript parsing, ingest backlog, pending summaries and summary
failures, with the fix for each. Hook errors go to `~/.cc-debrief/hook-errors.log`; hooks never print anything into
your Claude Code session.

## Uninstall

```bash
npx cc-debrief uninit
```

This removes the four hooks and `~/.cc-debrief/bin/`, and keeps your data. Delete `~/.cc-debrief/` to remove the data
as well.

## Issues and contributing

Bugs and ideas go to [GitHub issues](https://github.com/ease-my-work/cc-debrief/issues); include the output of
`npx cc-debrief doctor`, and never paste transcripts, prompts or keys. Security problems go through private reporting,
see [SECURITY.md](SECURITY.md). cc-debrief has one maintainer and does not take pull requests; see
[CONTRIBUTING.md](CONTRIBUTING.md). How it works inside is in [docs/](docs/README.md).

## License

[MIT](LICENSE)

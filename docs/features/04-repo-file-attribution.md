# 04 — Repo and file attribution

**Code:** `src/collector/git.ts`, `src/enrich.ts`, `src/derive/session.ts` (`fileChange()`, `resolveRepo()`, `applyNumstat()`), `src/derive/language.ts`

## Purpose
Ties each session to a git repo (root, remote, branch, HEAD at start and end) and records every file Claude edits
or writes, with lines added and removed. It powers the Repos view, the "Code changed" tile and the session
detail's file list.

## Behaviour
Git runs only in the `snapshot` worker (spawned by `SessionStart`) and the `enrich` worker (spawned by
`SessionEnd`, and run by `dashboard` / `cc-debrief enrich` for sessions not yet enriched), never in the hook. File
changes are derived from the transcript in `deriveSession()`, which is synchronous and runs no git.

1. **Start state (`snapshot`, hook-captured sessions only).** `repoInfo(cwd)` at session start; store `repo_id`, `branch` and `head_start` (with `head_start_source = 'snapshot'`). A resumed session keeps its first `head_start`. This is the one fact the transcript cannot give, and the reason for the `SessionStart` hook.
2. **Repo detection.** `repoInfo(dir)` runs `git` to find the root, the remote (`origin`, else the first remote), the current branch and HEAD. It returns `null` outside a git work tree or when `git` is unavailable.
3. **Repo id.** `repoIdFor(info)` = the normalized remote when there is one, else the root path. Normalization strips the protocol, user name and credentials, drops the port and a trailing `.git`, lowercases the host and turns `git@host:org/repo` into `host/org/repo`, so SSH and HTTPS remotes give the same id (`github.com/example-org/billing-api`). Root paths use forward slashes; on Windows the drive letter is lowercased.
4. Upsert `repos` (`repo_id`, `root_path`, `remote_url` without credentials, `name` = last segment of the remote id, else of the root). Set `sessions.repo_id` if not set.
5. **HEAD.** `head_end` = HEAD at enrich time. Without a snapshot `head_start` (backfilled sessions, or `snapshot` failed), `headAt(root, started_at)` tries the reflog (`HEAD@{<time>}`, ignored when the reflog does not reach back that far), then `git log -1 --before=<time>`, else `NULL`; `head_start_source` records `reflog` or `log`.
6. **Branch.** From `snapshot` when present, else the `gitBranch` of the session's first transcript line, else the current branch at enrich time.
7. **File changes.** For each `tool_calls` row with `tool_name` in `Edit`, `Write`, `MultiEdit`, `NotebookEdit` and `ok = 1`, one `file_changes` row:
   - `path`: `toolUseResult.filePath`, else `input.file_path` (`notebook_path` for NotebookEdit).
   - `repo_id` and relative path: `resolveRepo()` matches the path against known `repos` rows by the longest `root_path` prefix (case-insensitive for Windows paths) and stores it relative, with forward slashes; with no match, `repo_id = NULL` and the absolute path. During enrich, paths no repo covers are looked up with `repoInfo()` on their nearest existing directory; any repo found is upserted and the session is re-derived, so edits in a second working directory are attributed.
   - `lines_added` / `lines_removed`: from `toolUseResult.structuredPatch` (lines starting `+` / `-` in each hunk) when present. Without a patch: every old line counts as removed and every new line as added (`Edit`: `old_string` / `new_string`; `MultiEdit`: summed over `edits[]`; `NotebookEdit`: `new_source` as added; `Write`: `content` as added).
   - `approx = 1` when any source text carries a `…[truncated N bytes]` marker.
   - `language`: from the file extension via a fixed map; unknown extensions give `NULL`.
8. **Numstat reconciliation.** `numstat(root, head_start)` = `git diff --numstat` against the working tree, plus untracked text files (up to 1 MB) as all lines added. For a path whose only rows in the session are `Write` calls without a patch, the last row's counts are replaced with the numstat counts (a `Write` over an existing file otherwise over-counts added lines and never counts removed ones). The counts are kept in `meta` `numstat:<session_id>` and re-applied by every later derive. Skipped for backfilled sessions that ended more than 7 days ago, where the working tree no longer reflects the session.
9. `enriched_at` is set.

"Branches seen" in the Repos view = distinct non-null `sessions.branch` per repo in the range.

## Data
| Table | Columns | Notes |
| --- | --- | --- |
| `repos` | repo_id, root_path, remote_url, name | Keyed by normalized remote, else root path |
| `sessions` | repo_id, branch, head_start, head_start_source, head_end | Written here |
| `file_changes` | session_id, tool_call_id, repo_id, path, lines_added, lines_removed, language, approx | One row per successful edit or write; indexes `(repo_id, path)`, `(session_id)` |
| `meta` | `numstat:<session_id>` | Reconciled counts |

Transcript fields used (through `tool_calls`): `toolUseResult.filePath`, `toolUseResult.structuredPatch`,
`input.file_path`, `input.old_string`, `input.new_string`, `input.edits`, `input.content`, `input.notebook_path`,
`input.new_source`; `gitBranch` on the first line.

## Interfaces
- `src/collector/git.ts` → `repoInfo(cwd): Promise<RepoInfo | null>`, `repoIdFor(info): string`, `normalizeRemote()`, `headSha(root)`, `headAt(root, isoTime): Promise<{ sha; source: "reflog" | "log" } | null>`, `numstat(root, fromRef)`, `addedLinesSince()` (used by [11](11-skill-claudemd-suggestions.md) to check which lines were kept).
- `src/enrich.ts` → `snapshotSession()`, `enrichSession(db, sessionId, { ai, … })`, `enrichPending()`.
- `src/db/queries/repos.ts` → `upsertRepo()`.
- API: `GET /api/repos`, `GET /api/repos/:id` (most-edited files, session-type mix), `GET /api/sessions/:id` (files touched), `GET /api/overview` ("Code changed" tile).
- CLI: `enrich`, `rebuild`, `export`.

## UI
- Overview tile "Code changed": lines added and removed, files and repos touched.
- Session detail "Files" panel: path with added count, a "N more files" overflow. Rows are per repo and path; when a session edited files in more than one repo, each path is prefixed with its repo name.
- Repos table: name with branches seen, remote (or "no remote"), sessions, tokens, cost, lines +/−.
- Repo detail: most-edited files (path, sessions, lines added) and the session-type mix.
- Views other than Repos have a repo filter.

## Edge cases and failure modes
- `cwd` not in a git repo, or `git` not on PATH: `repo_id = NULL`; the session is listed under "no repo"; file changes keep absolute paths.
- No remote: `repo_id` = root path; shown as "no remote".
- Remote URL with embedded credentials: stripped before `remote_url` and `repo_id` are stored.
- Detached HEAD: `branch = NULL`; HEADs still recorded.
- Reflog expired or disabled: `head_start` from `git log --before`, else `NULL` (never guessed).
- Edits outside any repo (for example `~/.claude/settings.json`): `repo_id = NULL`, excluded from repo totals.
- Failed edit (`ok = 0`): no `file_changes` row.
- Truncated tool input or patch: counts from the available text, row flagged `approx`.
- Nested repos (submodules): a file goes to the innermost repo containing it.
- Every git command has a 3 s timeout and runs with `windowsHide: true` and a non-interactive, English environment; a timeout leaves the field `NULL`.

## Dependencies
- Depends on: [01 — Session capture](01-session-capture.md), [03 — Tool, MCP and skill usage](03-tool-mcp-skill-usage.md).
- Depended on by: [05](05-inventory-scan.md) (repo root and id), [07](07-session-review-tier1.md), [10](10-repeat-pattern-detection.md), [11](11-skill-claudemd-suggestions.md), [12 — Dashboard](12-dashboard.md).

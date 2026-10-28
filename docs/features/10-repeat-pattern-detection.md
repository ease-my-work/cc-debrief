# 10 — Repeat-pattern detection

**Code:** `src/patterns/` (`detect.ts`, `graph.ts`, `classify.ts`, `crossrepo.ts`, `run.ts`, `fingerprint.ts`, `labels.ts`, `similarity.ts`)

## Purpose

Developers often do the same kind of work in a repo again and again (fixing scanner findings, adding a migration,
re-explaining a convention) without noticing that each repetition costs a full session of tokens. Detection finds
recurring work per repo, classifies what kind of repeat it is, and records a `patterns` row that
[11 — Skill and CLAUDE.md suggestions](11-skill-claudemd-suggestions.md) turns into a draft skill or rule. It is pure
JS over the database: no git, no network, no model call.

## Behaviour

### Signals

A cluster needs signal 1 or signal 2. Signal 3 only corroborates and never creates a cluster on its own.

1. **Task label.** `reviews.result.task_pattern` from Tier 2 ([08](08-session-review-tier2.md)); a session with several
   reviews uses the newest. `normalizeLabel()` lowercases, splits on non-alphanumerics, drops stop words and tokens
   under 3 characters, stems each token (plural first, then `-ing` or `-ed`, never below 3 characters) and keeps the
   distinct tokens in order: `normalizeLabel("Fixing Trivy findings!")` is `fix trivy find`. Two labels match
   (`sameLabel()`) when their normalized forms are equal or their token Jaccard is ≥ 0.8. Without Tier 2 reviews this
   signal is absent.
2. **Tool-sequence fingerprint.** `toolSkeleton()` turns a session's main-transcript tool calls (no subagents, by start
   time) into steps `Tool:arg`: the shell command key ([07](07-session-review-tier1.md)) for `Bash` and `PowerShell`;
   the file basename for `Read`, `Edit`, `Write`, `MultiEdit`, `NotebookEdit`; `mcp:<server>` for MCP tools; empty
   otherwise (`Grep:`). Consecutive identical steps collapse. Example:
   `Bash:trivy → Read:Dockerfile → Edit:Dockerfile → Bash:docker build`. `trigramJaccard()` compares the sets of
   consecutive step trigrams; two sessions match at ≥ 0.6. Sessions with fewer than three distinct steps are not
   fingerprinted.
3. **Prompt similarity.** `tfidfCosine()` over each session's first prompt; a pair at ≥ 0.5 is marked corroborated.

### When it runs

- In `enrichSession()`, right after Tier 1 and inside the session lock: `detectForSession()` runs detection for that
  session's repo. It never throws (errors go to `coach-errors.log`) and does nothing for a session without a repo.
- On `cc-debrief dashboard` start, after the digest rules: `runPatternDetection()` runs `detectPatterns()` for every
  repo with sessions in the last 30 days, then the cross-repo run, then `checkInstalledPatterns()`
  ([11](11-skill-claudemd-suggestions.md)). Each step is isolated, so one failing repo does not stop the others, and
  the run stops between repos when the dashboard shuts down.

### Detection steps (`detectPatterns(db, repoId)`)

1. Load the repo's sessions started in the last 30 days, at most the 500 newest, excluding the tracker's own call
   sessions (those with a `self_usage` or `ai_calls` row).
2. Build a graph: an edge joins two sessions that share a label or have fingerprint Jaccard ≥ 0.6. Prompt similarity
   only marks existing edges.
3. Take connected components. A component is a candidate when it has ≥ 3 sessions and their non-cached tokens
   (input + cache creation + output) total at least `DIGEST_COST_FLOOR_TOKENS` (50,000). This sum is the pattern's
   `tokens_total` and its finding's `cost_tokens`.
4. Classify (first match wins):

   | Order | Condition | `kind` |
   | --- | --- | --- |
   | 1 | ≥ 3 sessions of the component have `session_type = 'bugfix'` and edit the same file | `test_gap` |
   | 2 | Correction sentences from ≥ 3 sessions, linked by TF-IDF cosine ≥ 0.5 | `claude_md_rule` |
   | 3 | The same set of ≥ 2 files is `Read` among the first five tool calls in ≥ 50% of the repo's sessions (minimum 3) | `claude_md_pointer` |
   | 4 | Otherwise | `repo_skill` |

   - **Rule 2.** Non-first prompts are split into sentences on `.`, `!`, `?` and newlines. A correction sentence
     matches `use X not Y`, `don't`, `do not`, `instead of`, `instead`, `stop` or `never` (case-insensitive, English
     only). Sentences of different sessions with cosine ≥ 0.5 are joined; a connected group spanning ≥ 3 sessions over
     the cost floor is a rule. Each sentence must be that close to another of the group, not to all of them, so
     "use httpx not requests", "don't use requests, use httpx" and "stop using requests; httpx instead" form one rule.
     Rule 2 also runs across all the repo's sessions, apart from the graph, because a repeated correction can occur in
     otherwise unrelated tasks.
   - **Rule 3** runs only across all the repo's sessions. A label-free component that is no longer fingerprintable once
     the pointer's start-up reads are removed is the pointer itself, not a repo skill.
   - Candidates with the same kind and normalized label are joined.
5. **Label.** The component's most frequent Tier 2 label, shown in its newest raw form; else the fingerprint of its
   newest fingerprintable session; for a rule, the most central correction sentence (≤ 200 characters); for a test
   gap, the file path; for a pointer, "Read at session start: a, b". The identity `label_norm` is the normalized label,
   `fp:<fingerprint>`, `path:<path>` or `pointer:<files>` respectively.
6. **Upsert** into `patterns` by `(repo_id, kind, label_norm)`. With no identity match, a row of the same repo and kind
   that shares ≥ 50% of its own sessions with the candidate is updated instead (it keeps its own label), so one
   recurring task stays one candidate.
7. **Status rules.** Rows are written only when something changed, so a rerun with no new sessions writes nothing.
   `drafted`, `installed` and `dismissed` rows keep their status, except that a row dismissed more than 30 days ago
   returns to `candidate` if it still qualifies. An `installed` row keeps its earlier `session_ids` (merged with new
   ones), so its "before install" sessions still count after they leave the 30-day window. A `candidate` row that no
   longer qualifies is deleted with its finding.
8. **Findings.** Each `candidate` or `drafted` pattern gets one session-less finding (`repeat_pattern`, or `test_gap`
   for a test gap; severity low; subject `pattern:<id>`; `cost_tokens = tokens_total`; target `repos`) so it can
   appear in the digest. Installed and dismissed patterns have none. Findings are synced per scope (one repo, or the
   cross-repo scope); the digest-rule recompute never touches them.

   | Kind | Message |
   | --- | --- |
   | `repo_skill`, `user_skill` | "Repeated work in `billing-api`: fix trivy findings — 4 sessions in 30 days" |
   | `test_gap` | "`services/cache.py` fixed in 3 separate bugfix sessions in `billing-api` — no test covers it" |
   | `claude_md_rule` | "Corrected by you in 3 sessions in `billing-api`: "use httpx not requests"" |
   | `claude_md_pointer` | "The same files are read at the start of 4 sessions in `billing-api`" |

### Cross-repo repeats

After the per-repo runs, `crossRepoPatterns()` compares labels and fingerprints across the 1,000 newest sessions of
the last 30 days in all repos. A component spanning ≥ 2 repos with ≥ 3 sessions over the cost floor becomes a
`patterns` row with `repo_id = NULL` and `kind = 'user_skill'`, which suggests a user-level skill. Sessions without a
repo join only by label. The same upsert, status and finding rules apply.

### Thresholds

| Constant | Value |
| --- | --- |
| Label Jaccard (`SAME_LABEL_JACCARD`) | 0.8 |
| Fingerprint Jaccard (`FINGERPRINT_JACCARD`) | 0.6 |
| Prompt cosine (`PROMPT_COSINE`), correction cosine | 0.5 |
| Minimum sessions (`MIN_SESSIONS`) | 3 |
| Cost floor (`DIGEST_COST_FLOOR_TOKENS`) | 50,000 non-cached tokens |
| Pointer share; session-overlap merge | 50% |
| Window (`WINDOW_DAYS`) | 30 days |
| Sessions per repo (`MAX_SESSIONS`); across repos (`CROSS_REPO_MAX_SESSIONS`) | 500; 1,000 |

## Data

| Table | Access | Notes |
| --- | --- | --- |
| `patterns` | read, write | id, repo_id (NULL = cross-repo), label, label_norm, kind, session_ids JSON, tokens_total, fingerprint, meta JSON, first_seen, last_seen, status (`candidate` / `drafted` / `installed` / `dismissed`), draft_path, inventory_id, installed_at, dismissed_at, agent |
| `reviews` | read | `result.task_pattern` |
| `tool_calls`, `turns` | read | Skeletons, start-up reads, first prompts, corrections |
| `file_changes`, `sessions`, `usage` | read | Test gaps, session type, tokens |
| `self_usage`, `ai_calls` | read | Exclusion list |
| `repos` | read | Repo name for messages, root path for pointer files |
| `findings` | write | `repeat_pattern`, `test_gap` |

`008_patterns.sql` creates the table with a unique index on `(COALESCE(repo_id, ''), kind, label_norm)` and an index
on `(repo_id, status)`. `patterns.meta` holds kind-specific facts: `correctionCount` and `corrections` (rules),
`readFiles` (pointers), `testGapPath` (test gaps), and the last draft `error`.

## Interfaces

```ts
// src/patterns/fingerprint.ts
export function toolSkeleton(calls: { tool_name: string; input: unknown; mcp_server: string | null }[]): Step[];
export function trigramJaccard(a: Step[], b: Step[]): number;        // 0..1
// src/patterns/similarity.ts
export function terms(text: string): string[];                       // tokenizer + stemmer
export function tfidfCosine(docs: string[]): number[][];
// src/patterns/labels.ts
export function normalizeLabel(label: string): string;
export function sameLabel(a: string, b: string): boolean;
// src/patterns/detect.ts, crossrepo.ts, run.ts
export type PatternKind = "repo_skill" | "user_skill" | "claude_md_rule" | "claude_md_pointer" | "test_gap";
export function detectPatterns(db: Db, repoId: string | null, now?: Date): { created: number; updated: number };
export function crossRepoPatterns(db: Db, now?: Date): { created: number; updated: number };
export function detectForSession(db: Db, sessionId: string, now?: Date): void;
export function runPatternDetection(db: Db, opts?: { now?: Date; signal?: AbortSignal;
  afterwards?: (db: Db, now: Date) => void }): number;
```

| Method and path | Response |
| --- | --- |
| `GET /api/patterns?repo=<repo_id>&status=` | `{ patterns: PatternRow[] }`, highest `tokensTotal` first; `estDraftUsd` is set for `candidate` and `drafted` rows of kinds with an AI draft |
| `POST /api/patterns/:id/dismiss` | `{ ok: true }`; sets `dismissed_at` and removes the pattern's digest finding at once; `404 not_found` |

Draft and install routes are in [11](11-skill-claudemd-suggestions.md).

## UI

- **Repos view, "Repeated work · suggestions" panel** ([12](12-dashboard.md)): one card per pattern with a kind badge
  ("repo skill", "user skill", "CLAUDE.md rule", "CLAUDE.md pointer"), the label, a muted line with session count,
  tokens and fingerprint, and the actions from [11](11-skill-claudemd-suggestions.md) plus Dismiss. Test gaps render
  as a single line with a "test gap" badge. Order: candidates by tokens, then drafted, then installed, then test gaps;
  dismissed rows are left out. An empty panel reads "No repeated work found in the last 30 days."
- **Overview digest:** candidates and drafted patterns appear through their finding ([09](09-weekly-coaching-digest.md)).
- **Skills & Tools:** the "Skills proposed from repeated work" table lists skill patterns ([11](11-skill-claudemd-suggestions.md)).

## Edge cases and failure modes

- Tier 2 off: no labels; fingerprints still detect task repeats, and rule and pointer classification still run.
- Each session belongs to exactly one graph component. Rule and pointer candidates are built apart from the graph and
  may share sessions with a component's candidate.
- Sessions with no repo: excluded from per-repo detection; eligible for cross-repo only by label.
- A dismissed pattern leaves the digest at once and returns as a candidate only after 30 days, if it still qualifies.
- Label fragmentation ("fix trivy findings" vs "resolve trivy scan issues"): merged by `sameLabel()` or joined
  through fingerprint edges.
- A pattern drops below 3 sessions as old ones age out: a `candidate` row is deleted with its finding; `drafted` and
  `installed` rows are kept.
- Detection throws: logged; enrich continues.

## Dependencies

[03 — Tool, MCP and skill usage](03-tool-mcp-skill-usage.md), [04 — Repo and file attribution](04-repo-file-attribution.md),
[06 — AI session summary](06-ai-session-summary.md), [08 — Session review, Tier 2](08-session-review-tier2.md),
[09 — Weekly coaching digest](09-weekly-coaching-digest.md), [11 — Skill and CLAUDE.md suggestions](11-skill-claudemd-suggestions.md),
[12 — Dashboard](12-dashboard.md).

-- 001: capture schema (Phase 1). Every table has agent TEXT NOT NULL DEFAULT 'claude-code'.

CREATE TABLE meta (
  key TEXT PRIMARY KEY, value TEXT NOT NULL,
  agent TEXT NOT NULL DEFAULT 'claude-code');

CREATE TABLE repos (
  repo_id TEXT PRIMARY KEY, root_path TEXT NOT NULL, remote_url TEXT, name TEXT NOT NULL,
  agent TEXT NOT NULL DEFAULT 'claude-code');

CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY, started_at TEXT, ended_at TEXT, cwd TEXT,
  repo_id TEXT REFERENCES repos(repo_id), branch TEXT,
  surface TEXT NOT NULL DEFAULT 'unknown', entrypoint TEXT, cc_version TEXT,
  capture TEXT NOT NULL DEFAULT 'backfill' CHECK (capture IN ('hooks', 'backfill')),
  start_reason TEXT, permission_mode TEXT, models TEXT NOT NULL DEFAULT '[]',
  head_start TEXT, head_start_source TEXT, head_end TEXT,
  summary TEXT, session_type TEXT, type_source TEXT, outcome TEXT, tags TEXT, summary_error TEXT,
  enriched_at TEXT, discard_checked_at TEXT,
  title TEXT, agent_name TEXT,                  -- last custom-title, else last ai-title / last agent-name (Phase 0 A9)
  reported_cost_usd REAL, reported_usage TEXT,  -- last cost-state line (Phase 0 A2/A3); NULL when absent or ids shared
  agent TEXT NOT NULL DEFAULT 'claude-code');
CREATE INDEX sessions_started ON sessions(started_at);

CREATE TABLE events (
  id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, event TEXT NOT NULL, ts TEXT NOT NULL, payload TEXT NOT NULL,
  agent TEXT NOT NULL DEFAULT 'claude-code');
CREATE INDEX events_session_ts ON events(session_id, ts);

CREATE TABLE transcripts (
  id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL, agent_id TEXT, size INTEGER NOT NULL, mtime_ms INTEGER NOT NULL,
  bytes_ingested INTEGER NOT NULL DEFAULT 0, first_line_uuid TEXT, lines INTEGER NOT NULL DEFAULT 0,
  parse_errors INTEGER NOT NULL DEFAULT 0, internal INTEGER NOT NULL DEFAULT 0,
  cwd TEXT,                                     -- first line cwd; slimLine() drops it from each stored line
  first_ingested_at TEXT, last_ingested_at TEXT, missing_since TEXT, purged_at TEXT,
  agent TEXT NOT NULL DEFAULT 'claude-code');
CREATE INDEX transcripts_session ON transcripts(session_id);

CREATE TABLE transcript_lines (
  id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, agent_id TEXT,
  file_id INTEGER NOT NULL REFERENCES transcripts(id), line_no INTEGER NOT NULL,  -- path stored once per file (D1)
  uuid TEXT, parent_uuid TEXT, type TEXT NOT NULL, subtype TEXT, ts TEXT,
  payload BLOB NOT NULL,                        -- encodePayload(): raw deflate of the redacted, capped, slimmed JSON
  agent TEXT NOT NULL DEFAULT 'claude-code',
  UNIQUE (file_id, line_no));
CREATE INDEX transcript_lines_session_ts ON transcript_lines(session_id, ts);

CREATE TABLE turns (
  id INTEGER PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  prompt_id TEXT, seq INTEGER NOT NULL, user_text TEXT, assistant_text TEXT, started_at TEXT, ended_at TEXT,
  agent TEXT NOT NULL DEFAULT 'claude-code');
CREATE INDEX turns_started_at ON turns(started_at);  -- day bucketing for the work recap (feature 17)

CREATE TABLE usage (
  id INTEGER PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  agent_id TEXT, turn_id INTEGER, message_id TEXT, request_id TEXT, model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL, ts TEXT,
  agent TEXT NOT NULL DEFAULT 'claude-code');
CREATE INDEX usage_session ON usage(session_id);
-- Global dedupe (Phase 0 A2): a message copied into a fork or rewind is owned by the earliest session.
CREATE UNIQUE INDEX usage_message ON usage(message_id, COALESCE(request_id, '')) WHERE message_id IS NOT NULL;

CREATE TABLE tool_calls (
  id INTEGER PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  agent_id TEXT, turn_id INTEGER, tool_use_id TEXT, tool_name TEXT NOT NULL, mcp_server TEXT,
  mcp_source TEXT,                              -- plugin:<plugin> | claude.ai | NULL (Phase 0 A4)
  mcp_tool TEXT, skill_name TEXT, input BLOB, response BLOB,  -- encodePayload()
  started_at TEXT, ended_at TEXT, ok INTEGER, denied TEXT,
  exit_code INTEGER,                            -- from "Exit code N" (Bash / PowerShell, Phase 0 A5)
  agent TEXT NOT NULL DEFAULT 'claude-code');
CREATE INDEX tool_calls_session_tool ON tool_calls(session_id, tool_name);
CREATE INDEX tool_calls_session_started ON tool_calls(session_id, started_at);

CREATE TABLE file_changes (
  id INTEGER PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  tool_call_id INTEGER, repo_id TEXT, path TEXT NOT NULL, lines_added INTEGER NOT NULL DEFAULT 0,
  lines_removed INTEGER NOT NULL DEFAULT 0, language TEXT, approx INTEGER NOT NULL DEFAULT 0,
  agent TEXT NOT NULL DEFAULT 'claude-code');
CREATE INDEX file_changes_repo_path ON file_changes(repo_id, path);

CREATE TABLE instructions_loaded (
  id INTEGER PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  file_path TEXT NOT NULL, kind TEXT, ts TEXT,
  agent TEXT NOT NULL DEFAULT 'claude-code');

CREATE TABLE subagents (
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE, agent_id TEXT NOT NULL,
  agent_type TEXT, description TEXT, tool_use_id TEXT, started_at TEXT, ended_at TEXT,
  agent TEXT NOT NULL DEFAULT 'claude-code',
  PRIMARY KEY (session_id, agent_id));

CREATE TABLE compactions (
  id INTEGER PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  ts TEXT, trigger TEXT, pre_tokens INTEGER, post_tokens INTEGER,
  agent TEXT NOT NULL DEFAULT 'claude-code');

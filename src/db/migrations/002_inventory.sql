-- 002_inventory (Phase 2): installed skills, plugins, MCP servers and hooks, and which sessions loaded or invoked them.

CREATE TABLE inventory (
  id INTEGER PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('user', 'repo', 'plugin')),
  repo_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('skill', 'plugin', 'mcp', 'hook')),
  name TEXT NOT NULL, path TEXT NOT NULL, description TEXT,
  first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
  meta TEXT NOT NULL DEFAULT '{}',              -- JSON; MCP env values and headers are never stored
  agent TEXT NOT NULL DEFAULT 'claude-code');
-- COALESCE: two NULL repo_ids would otherwise never collide.
CREATE UNIQUE INDEX inventory_identity ON inventory(agent, scope, COALESCE(repo_id, ''), kind, name);

CREATE TABLE inventory_usage (
  inventory_id INTEGER NOT NULL REFERENCES inventory(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  loaded INTEGER NOT NULL DEFAULT 0, invoked INTEGER NOT NULL DEFAULT 0,
  agent TEXT NOT NULL DEFAULT 'claude-code',
  PRIMARY KEY (inventory_id, session_id));
-- Per-session rebuilds in deriveSession() and the session-delete cascade look rows up by session.
CREATE INDEX inventory_usage_session ON inventory_usage(session_id);
-- "Last used" and status read only invoked rows; without this they scan every usage row (Phase 2: 395 ms → 1 ms on
-- 80k rows).
CREATE INDEX inventory_usage_invoked ON inventory_usage(inventory_id, session_id) WHERE invoked = 1;

-- Dashboard lookups by session (Phase 2): first prompt and turns per session, lines per session.
CREATE INDEX turns_session_seq ON turns(session_id, seq);
CREATE INDEX file_changes_session ON file_changes(session_id);
CREATE INDEX instructions_loaded_session ON instructions_loaded(session_id);

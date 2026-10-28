-- 009: inventory kinds for agents, commands, output styles, rules and workflows (Phase 7 P11, spec decision 2).
-- SQLite cannot alter a CHECK, so the table is rebuilt (the 12-step procedure): migrate() runs this file with
-- foreign_keys OFF, so dropping the old table cascades nothing, and checks foreign keys before it commits. Row ids are
-- copied, so inventory_usage and patterns.inventory_id stay valid.

CREATE TABLE inventory_new (
  id INTEGER PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('user', 'repo', 'plugin')),
  repo_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('skill', 'plugin', 'mcp', 'hook', 'agent', 'command', 'output_style', 'rule', 'workflow')),
  name TEXT NOT NULL, path TEXT NOT NULL, description TEXT,
  first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
  meta TEXT NOT NULL DEFAULT '{}',              -- JSON; MCP env values and headers are never stored
  agent TEXT NOT NULL DEFAULT 'claude-code');

INSERT INTO inventory_new (id, scope, repo_id, kind, name, path, description, first_seen, last_seen, meta, agent)
  SELECT id, scope, repo_id, kind, name, path, description, first_seen, last_seen, meta, agent FROM inventory;

DROP TABLE inventory;
ALTER TABLE inventory_new RENAME TO inventory;
-- COALESCE: two NULL repo_ids would otherwise never collide.
CREATE UNIQUE INDEX inventory_identity ON inventory(agent, scope, COALESCE(repo_id, ''), kind, name);

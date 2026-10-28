-- 004: coaching findings (Phase 4, features 07 and 09). session_id is NULL for digest-rule findings; subject_key is
-- the finding's evidence.key ('' when none), repo_id the session's repo or the digest rule's subject repo.

CREATE TABLE findings (
  id INTEGER PRIMARY KEY,
  session_id TEXT REFERENCES sessions(session_id) ON DELETE CASCADE,
  rule TEXT NOT NULL, subject_key TEXT NOT NULL DEFAULT '', repo_id TEXT,
  severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high')),
  message TEXT NOT NULL, evidence TEXT NOT NULL, cost_tokens INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, dismissed_until TEXT,
  feedback TEXT CHECK (feedback IN ('helpful', 'not_helpful')),
  agent TEXT NOT NULL DEFAULT 'claude-code');
-- COALESCE: two NULL session_ids would otherwise never collide.
CREATE UNIQUE INDEX findings_identity ON findings(COALESCE(session_id, ''), rule, subject_key);
CREATE INDEX findings_created ON findings(created_at);
CREATE INDEX findings_rule_repo ON findings(rule, repo_id);

CREATE TABLE rule_feedback (
  rule TEXT PRIMARY KEY, helpful INTEGER NOT NULL DEFAULT 0, not_helpful INTEGER NOT NULL DEFAULT 0,
  demoted INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
  agent TEXT NOT NULL DEFAULT 'claude-code');

-- The TIER1_VERSION a session was last checked with; NULL = never (dashboard start re-checks the last 30 days).
ALTER TABLE sessions ADD COLUMN tier1_version INTEGER;

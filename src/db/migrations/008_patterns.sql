-- 008: repeat patterns (Phase 5b, features 10 and 11). repo_id NULL = cross-repo (user_skill). label_norm is the
-- identity, fingerprint the display skeleton; meta holds kind-specific facts (correctionCount, readFiles,
-- testGapPath, corrections, the last draft error). installed_at / dismissed_at drive adoption and the 30-day return.

CREATE TABLE patterns (
  id INTEGER PRIMARY KEY, repo_id TEXT, label TEXT NOT NULL, label_norm TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('repo_skill', 'user_skill', 'claude_md_rule', 'claude_md_pointer', 'test_gap')),
  session_ids TEXT NOT NULL DEFAULT '[]', tokens_total INTEGER NOT NULL DEFAULT 0, fingerprint TEXT,
  meta TEXT NOT NULL DEFAULT '{}',
  first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate', 'drafted', 'installed', 'dismissed')),
  draft_path TEXT, inventory_id INTEGER REFERENCES inventory(id) ON DELETE SET NULL,
  installed_at TEXT, dismissed_at TEXT,
  agent TEXT NOT NULL DEFAULT 'claude-code');
-- COALESCE: two NULL repo_ids would otherwise never collide.
CREATE UNIQUE INDEX patterns_identity ON patterns(COALESCE(repo_id, ''), kind, label_norm);
CREATE INDEX patterns_repo_status ON patterns(repo_id, status);

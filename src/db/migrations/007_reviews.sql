-- 007: Tier 2 reviews (Phase 5a, feature 08). One row per session: a re-review replaces it. result is the validated
-- review JSON (schema_version 1); cost_usd is ClaudeResult.costUsd; feedback is the review's "Was this useful?".

CREATE TABLE reviews (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE REFERENCES sessions(session_id) ON DELETE CASCADE,
  schema_version INTEGER NOT NULL, result TEXT NOT NULL, cost_usd REAL, model TEXT,
  created_at TEXT NOT NULL,
  feedback TEXT CHECK (feedback IN ('helpful', 'not_helpful')),
  agent TEXT NOT NULL DEFAULT 'claude-code');
CREATE INDEX reviews_created ON reviews(created_at);

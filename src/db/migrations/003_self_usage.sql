-- 003: the tracker's own claude -p calls (Phase 3, feature 15). ai_calls is the daily-cap ledger, one row per attempt
-- written before the spawn; self_usage holds each finished call's own usage. 'recap' is allowed now because SQLite
-- cannot alter a CHECK later and Phase 6 writes it.

CREATE TABLE ai_calls (
  id INTEGER PRIMARY KEY,
  feature TEXT NOT NULL CHECK (feature IN ('summary', 'review', 'draft', 'recap')),
  session_id TEXT,                              -- the call's own session id, filled after the call returns
  target_session_id TEXT,                       -- the user session summarized or reviewed
  ts TEXT NOT NULL,
  agent TEXT NOT NULL DEFAULT 'claude-code');
CREATE INDEX ai_calls_feature_ts ON ai_calls(feature, ts);

CREATE TABLE self_usage (
  id INTEGER PRIMARY KEY,
  feature TEXT NOT NULL CHECK (feature IN ('summary', 'review', 'draft', 'recap')),
  session_id TEXT NOT NULL UNIQUE, target_session_id TEXT, model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL,                                -- this call's own usage x PRICE_TABLE; NULL for an unknown model
  raw_total_cost_usd REAL,                      -- total_cost_usd as reported (cumulative with a resumed session, C4)
  ts TEXT NOT NULL,
  agent TEXT NOT NULL DEFAULT 'claude-code');
CREATE INDEX self_usage_ts ON self_usage(ts);

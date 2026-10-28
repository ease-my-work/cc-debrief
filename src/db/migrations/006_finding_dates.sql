-- 006: a session finding is dated by its session's last activity, not by when Tier 1 ran (review 2026-10-10, B1), so
-- imported history and re-checks stop landing in "This week's digest". Session-less rows are recomputed on dashboard
-- start.

UPDATE findings SET created_at = (
  SELECT coalesce(s.ended_at, s.started_at) FROM sessions s WHERE s.session_id = findings.session_id)
WHERE session_id IS NOT NULL
  AND (SELECT coalesce(s.ended_at, s.started_at) FROM sessions s WHERE s.session_id = findings.session_id) IS NOT NULL;

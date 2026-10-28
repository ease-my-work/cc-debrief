-- 005: the skill_unused and discarded_work signals were removed in Phase 4 tuning; drop what they stored.
-- sessions.discard_checked_at (001) stays, unused.

DELETE FROM findings WHERE rule IN ('skill_unused', 'discarded_work');
DELETE FROM rule_feedback WHERE rule IN ('skill_unused', 'discarded_work');

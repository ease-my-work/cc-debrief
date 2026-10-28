// Badge and digest labels per rule (Phase 4 spec decision 8; skill_unused and discarded_work removed in tuning; Tier 2
// rules from Phase 5a spec decision 8; pattern rules from Phase 5b spec decision 6).

export const RULE_LABELS: Record<string, string> = {
	long_session_no_compaction: "long session",
	mcp_bypassed: "MCP bypassed",
	retry_loop: "retry loop",
	context_churn: "context churn",
	permission_friction: "permission friction",
	unused_skill: "unused skill",
	unused_mcp: "unused MCP",
	cache_hit_dip: "cache dip",
	model_mix: "model mix",
	tool_failure_hotspot: "failure hotspot",
	goal_drift: "goal drift",
	review_friction: "friction",
	repeat_pattern: "repeated work",
	test_gap: "test gap",
	skill_not_triggering: "skill not triggering",
	budget_over: "over budget", // Phase 7 P4
	spend_spike: "spend spike", // Phase 7 P5
};

/** The rule's label, else the rule id with underscores as spaces. */
export const ruleLabel = (rule: string): string => RULE_LABELS[rule] ?? rule.replaceAll("_", " ");

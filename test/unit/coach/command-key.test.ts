import { describe, expect, it } from "vitest";
import { commandKey } from "../../../src/coach/command-key";
import { RULE_LABELS } from "../../../src/coach/labels";

describe("commandKey", () => {
	it.each([
		["npm test -- -u", "npm test"],
		["NODE_ENV=x sudo pytest -k a", "pytest"],
		["npx vitest run", "vitest"],
		["python -m pytest", "pytest"],
		["uv run ruff check", "ruff"],
		["C:\\bin\\git.exe status", "git status"],
		["/usr/bin/git log --oneline", "git log"],
		["cargo build --release", "cargo build"],
		["make", "make"],
		["git -C repo status", "git"],
		["npx -y prettier --check .", "prettier"],
		["python3 -m pytest -x", "pytest"],
		['& "C:\\tools\\pytest.exe" -k a', "pytest"],
		["  pytest   tests/  ", "pytest"],
		["psql -c 'select 1'", "psql"],
	])("%s → %s", (command, key) => {
		expect(commandKey(command)).toBe(key);
	});

	it("keys only the first segment of a compound command, so `cd a && make build` is `cd`", () => {
		expect(commandKey("cd a && make build")).toBe("cd");
		expect(commandKey("pytest; echo done")).toBe("pytest");
		expect(commandKey("pytest | tee out.txt")).toBe("pytest");
		expect(commandKey("pytest\necho done")).toBe("pytest");
	});

	it("returns an empty string for an empty command", () => {
		expect(commandKey("")).toBe("");
		expect(commandKey("   ")).toBe("");
	});
});

describe("RULE_LABELS", () => {
	it("labels the ten Phase 4 rules (spec decision 8, less skill_unused and discarded_work removed in tuning), the two Tier 2 rules, the three pattern rules and the two Phase 7 spend rules", () => {
		expect(RULE_LABELS).toEqual({
			long_session_no_compaction: "long session",
			mcp_bypassed: "MCP bypassed",
			retry_loop: "retry loop",
			context_churn: "context churn",
			permission_friction: "permission friction",
			unused_skill: "unused skill",
			goal_drift: "goal drift",
			review_friction: "friction",
			repeat_pattern: "repeated work",
			test_gap: "test gap",
			skill_not_triggering: "skill not triggering",
			unused_mcp: "unused MCP",
			cache_hit_dip: "cache dip",
			model_mix: "model mix",
			tool_failure_hotspot: "failure hotspot",
			budget_over: "over budget",
			spend_spike: "spend spike",
		});
	});
});

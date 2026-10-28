import { describe, expect, it } from "vitest";
import { permissionFriction } from "../../../src/coach/signals/permission-friction";
import { at, call, ctx, permission } from "../../helpers/ctx";

/** n requests for `tool`, one a minute; each call's result arrives 20 s after its request. */
function requests(tool: string, n: number, from = 0) {
	const perms = Array.from({ length: n }, (_, i) => permission(tool, at(from + i, 5)));
	const calls = Array.from({ length: n }, (_, i) => call(tool, {}, { at: at(from + i), ms: 25_000 }));
	return { perms, calls };
}

describe("permission_friction", () => {
	it("fires on 8 prompts for one tool with wait time and denied count", () => {
		const { perms, calls } = requests("Bash", 8);
		calls[7] = { ...calls[7], ok: false, denied: "user" };
		const [f] = permissionFriction.detect(ctx({ permissionRequests: perms, toolCalls: calls }));
		expect(f).toEqual({
			rule: "permission_friction",
			severity: "low",
			message: "8 prompts for Bash — consider a permission allowlist",
			evidence: { key: "Bash", tool: "Bash", count: 8, denied: 1, waitMs: 8 * 20_000 },
			costTokens: 0,
			target: "session",
		});
	});

	it("does not fire on 7, is medium at 15", () => {
		const seven = requests("Bash", 7);
		expect(permissionFriction.detect(ctx({ permissionRequests: seven.perms, toolCalls: seven.calls }))).toEqual([]);
		const fifteen = requests("Bash", 15);
		const [f] = permissionFriction.detect(ctx({ permissionRequests: fifteen.perms, toolCalls: fifteen.calls }));
		expect(f.severity).toBe("medium");
	});

	it("never fires for an imported session", () => {
		const { perms, calls } = requests("Bash", 20);
		expect(
			permissionFriction.detect(ctx({ capture: "backfill", permissionRequests: perms, toolCalls: calls })),
		).toEqual([]);
	});

	it("counts tools separately and names an MCP tool's server", () => {
		const a = requests("Bash", 8);
		const b = requests("mcp__github__create_issue", 9, 20).perms.map((p) => ({ ...p, mcpServer: "github" }));
		const findings = permissionFriction.detect(ctx({ permissionRequests: [...a.perms, ...b], toolCalls: a.calls }));
		expect(findings.map((f) => f.message)).toEqual([
			"8 prompts for Bash — consider a permission allowlist",
			"9 prompts for mcp__github__create_issue (github MCP) — consider a permission allowlist",
		]);
		// No calls recorded for the MCP tool: no wait time measured.
		expect(findings[1].evidence.waitMs).toBe(0);
	});
});

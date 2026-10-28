import { describe, expect, it } from "vitest";
import { expectHash, routeHook } from "../../src/hook/run";

const SID = "ff13b0ac-642e-45f9-982e-701c122e54ec";
const p = (event: string, extra: object = {}) => ({ session_id: SID, hook_event_name: event, ...extra });

describe("routeHook", () => {
	it("spawns snapshot on SessionStart and inserts a row", () => {
		expect(routeHook(p("SessionStart", { cwd: "C:\\r", source: "startup" }), {})).toEqual({
			spawn: ["snapshot", SID, "--cwd", "C:\\r", "--from-hook"],
			insert: true,
		});
		expect(routeHook(p("SessionStart"), {})).toEqual({ spawn: ["snapshot", SID, "--from-hook"], insert: true });
	});

	it("spawns ingest with a hash on Stop and inserts nothing", () => {
		const r = routeHook(p("Stop", { last_assistant_message: "Done." }), {});
		expect(r).toEqual({ spawn: ["ingest", SID, "--from-hook", "--expect", expectHash("Done.")], insert: false });
		expect(routeHook(p("Stop", { last_assistant_message: "" }), {})).toEqual({
			spawn: ["ingest", SID, "--from-hook"],
			insert: false,
		});
		expect(routeHook(p("Stop"), {})).toEqual({ spawn: ["ingest", SID, "--from-hook"], insert: false });
	});

	it("only inserts on PermissionRequest", () => {
		expect(routeHook(p("PermissionRequest", { tool_name: "Bash" }), {})).toEqual({ spawn: null, insert: true });
	});

	it("spawns enrich on SessionEnd and inserts a row", () => {
		expect(routeHook(p("SessionEnd", { reason: "clear" }), {})).toEqual({
			spawn: ["enrich", SID, "--from-hook"],
			insert: true,
		});
	});

	it.each([
		["another event", p("PreToolUse"), {}],
		["missing session_id", { hook_event_name: "Stop" }, {}],
		["an unsafe session_id", p("Stop", { session_id: "../../x" }), {}],
		["a non-object payload", [1, 2], {}],
		["CC_DEBRIEF_INTERNAL=1", p("SessionStart", { cwd: "/r" }), { CC_DEBRIEF_INTERNAL: "1" }],
	])("does nothing for %s", (_name, payload, env) => {
		expect(routeHook(payload, env)).toEqual({ spawn: null, insert: false });
	});
});

describe("expectHash", () => {
	it("is 16 hex chars over the first 200 characters with whitespace collapsed", () => {
		expect(expectHash("Done.")).toMatch(/^[0-9a-f]{16}$/);
		expect(expectHash("  a\n\n b\t c ")).toBe(expectHash("a b c"));
		const long = "x".repeat(200);
		expect(expectHash(`${long}tail one`)).toBe(expectHash(`${long}tail two`));
		expect(expectHash("a")).not.toBe(expectHash("b"));
	});

	it("never carries the message text into the command line", () => {
		const secret = `sk-ant-api03-${"S".repeat(40)}`;
		const r = routeHook(p("Stop", { last_assistant_message: `Here is your key ${secret}` }), {});
		expect(r.spawn?.join(" ")).not.toContain("sk-ant");
		expect(r.spawn?.at(-1)).toMatch(/^[0-9a-f]{16}$/);
	});
});

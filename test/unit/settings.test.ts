import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	HOOK_ENTRY_OPTIONS,
	HOOK_MARKER,
	hookCommand,
	installHooks,
	readSettingsBytes,
	removeHooks,
	SettingsError,
	SUBSCRIBED_EVENTS,
	sha256,
} from "../../src/claude/settings";

const ALL = ["SessionStart", "Stop", "PermissionRequest", "SessionEnd"];
const CMD = hookCommand("/home/u/.cc-debrief/bin/hook.js");

let dir: string;
let file: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ccd-settings-"));
	file = join(dir, "settings.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const read = () => readFileSync(file, "utf8");
const json = () => JSON.parse(read().replace(/^\uFEFF/, ""));
const backups = () => readdirSync(dir).filter((f) => f.endsWith(".bak"));
const ours = (event: string) =>
	(json().hooks[event] ?? [])
		.flatMap((g: { hooks: { command: string }[] }) => g.hooks)
		.filter((h: { command: string }) => h.command.includes(HOOK_MARKER));

// As Claude Code writes it: 2-space JSON.stringify, trailing newline.
const USER = `{
  "model": "opus",
  "n": 1.50,
  "e": "caf\\u00e9",
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "notify.sh"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "prettier --write"
          }
        ]
      }
    ]
  }
}
`;
const USER_STOP_ENTRY = `      {
        "hooks": [
          {
            "type": "command",
            "command": "notify.sh"
          }
        ]
      }`;
const USER_POST_TOOL_USE = USER.slice(USER.indexOf('    "PostToolUse"'), USER.indexOf("\n  }\n}"));

describe("constants", () => {
	it("subscribe to four events with async Stop and a one-hour SessionEnd timeout", () => {
		expect([...SUBSCRIBED_EVENTS]).toEqual(ALL);
		expect(HOOK_ENTRY_OPTIONS).toEqual({
			SessionStart: {},
			Stop: { async: true },
			PermissionRequest: {},
			SessionEnd: { timeout: 3600 },
		});
	});

	it("quotes the hook path and keeps Windows backslashes", () => {
		expect(hookCommand("C:\\Users\\A B\\.cc-debrief\\bin\\hook.js")).toBe(
			'node "C:\\Users\\A B\\.cc-debrief\\bin\\hook.js" # cc-debrief',
		);
	});
});

describe("installHooks", () => {
	it("creates a missing file with the four entries and their options", () => {
		const r = installHooks(file, CMD);
		expect(r).toMatchObject({ added: ALL, skipped: [], replaced: [], staleRemoved: [], backupPath: null });
		expect(r.created).toEqual(["<file>", "hooks", ...ALL.map((e) => `hooks.${e}`)]);
		for (const e of ALL)
			expect(ours(e)).toEqual([
				{ type: "command", command: CMD, ...HOOK_ENTRY_OPTIONS[e as keyof typeof HOOK_ENTRY_OPTIONS] },
			]);
		expect(read().endsWith("}\n")).toBe(true);
		expect(r.afterSha).toBe(sha256(readFileSync(file)));
	});

	it("appends after the user's hooks and leaves every user byte in place", () => {
		writeFileSync(file, USER);
		const r = installHooks(file, CMD);
		expect(r.added).toEqual(ALL);
		expect(r.created).toEqual(["hooks.SessionStart", "hooks.PermissionRequest", "hooks.SessionEnd"]);
		const out = read();
		expect(out).toContain(USER_STOP_ENTRY);
		expect(out).toContain(USER_POST_TOOL_USE);
		expect(out).toContain('"n": 1.50');
		expect(out).toContain('"e": "caf\\u00e9"');
		expect(json().hooks.Stop.map((g: { hooks: { command: string }[] }) => g.hooks[0].command)).toEqual([
			"notify.sh",
			CMD,
		]);
		expect(readFileSync(r.backupPath as string, "utf8")).toBe(USER);
		expect(r.beforeSha).toBe(sha256(Buffer.from(USER)));
		expect(backups()[0]).toMatch(/^settings\.json\.cc-debrief-\d{8}-\d{6}\.bak$/);
	});

	it("adds nothing and writes nothing on a second install", () => {
		writeFileSync(file, USER);
		installHooks(file, CMD);
		const before = readFileSync(file);
		const r = installHooks(file, CMD);
		expect(r).toMatchObject({
			added: [],
			skipped: ALL,
			replaced: [],
			staleRemoved: [],
			changed: false,
			backupPath: null,
		});
		expect(readFileSync(file)).toEqual(before);
		expect(backups()).toHaveLength(1);
	});

	it("replaces a stale tracker command in place instead of adding a second entry", () => {
		installHooks(file, hookCommand("/old/place/hook.js"));
		const r = installHooks(file, CMD);
		expect(r.replaced).toEqual(ALL);
		expect(r.added).toEqual([]);
		for (const e of ALL) expect(ours(e).map((h: { command: string }) => h.command)).toEqual([CMD]);
	});

	it("replaces an entry whose options differ (Stop without async from an older version)", () => {
		installHooks(file, CMD);
		const s = json();
		delete s.hooks.Stop[0].hooks[0].async;
		writeFileSync(file, `${JSON.stringify(s, null, 2)}\n`);
		const r = installHooks(file, CMD);
		expect(r.replaced).toEqual(["Stop"]);
		expect(r.skipped).toEqual(["SessionStart", "PermissionRequest", "SessionEnd"]);
		expect(ours("Stop")[0].async).toBe(true);
	});

	it("removes tracker entries under events it no longer subscribes to, keeping the user's", () => {
		const s = JSON.parse(USER);
		s.hooks.PostToolUse.push({ hooks: [{ type: "command", command: `node "/x/hook.js" ${HOOK_MARKER}` }] });
		writeFileSync(file, `${JSON.stringify(s, null, 2)}\n`);
		const r = installHooks(file, CMD);
		expect(r.staleRemoved).toEqual(["PostToolUse"]);
		expect(json().hooks.PostToolUse).toEqual(JSON.parse(USER).hooks.PostToolUse);
	});

	it("drops an event array that only held a stale tracker entry", () => {
		writeFileSync(
			file,
			JSON.stringify({ hooks: { Notification: [{ hooks: [{ type: "command", command: `x ${HOOK_MARKER}` }] }] } }),
		);
		const r = installHooks(file, CMD);
		expect(r.staleRemoved).toEqual(["Notification"]);
		expect(json().hooks.Notification).toBeUndefined();
	});

	it("leaves PermissionRequest out when permissionHook is false", () => {
		const fresh = installHooks(file, CMD, { permissionHook: false });
		expect(fresh.added).toEqual(["SessionStart", "Stop", "SessionEnd"]);
		expect(json().hooks.PermissionRequest).toBeUndefined();
		rmSync(file);
		installHooks(file, CMD);
		const r = installHooks(file, CMD, { permissionHook: false });
		expect(r).toMatchObject({
			staleRemoved: ["PermissionRequest"],
			skipped: ["SessionStart", "Stop", "SessionEnd"],
			added: [],
		});
		expect(json().hooks.PermissionRequest).toBeUndefined();
	});

	it("keeps tabs, CRLF and the BOM", () => {
		const original =
			'\uFEFF{\r\n\t"model": "opus",\r\n\t"hooks": {\r\n\t\t"Stop": [\r\n\t\t\t{\r\n\t\t\t\t"hooks": [\r\n\t\t\t\t\t{\r\n\t\t\t\t\t\t"type": "command",\r\n\t\t\t\t\t\t"command": "notify.sh"\r\n\t\t\t\t\t}\r\n\t\t\t\t]\r\n\t\t\t}\r\n\t\t]\r\n\t}\r\n}\r\n';
		writeFileSync(file, original);
		installHooks(file, CMD);
		const out = read();
		expect(out.startsWith('\uFEFF{\r\n\t"model"')).toBe(true);
		expect(out.endsWith("}\r\n")).toBe(true);
		expect(out.replace(/\r\n/g, "")).not.toContain("\n");
		for (const line of out.split("\r\n")) expect(line).toMatch(/^\t*\S|^$|^\uFEFF/);
		expect(json().hooks.SessionEnd).toHaveLength(1);
	});

	it("refuses a file that is not valid JSON and writes nothing", () => {
		const bad = '{\n  // comment\n  "model": "opus"\n}\n';
		writeFileSync(file, bad);
		expect(() => installHooks(file, CMD)).toThrow(SettingsError);
		expect(read()).toBe(bad);
		expect(backups()).toEqual([]);
		writeFileSync(file, "[]");
		expect(() => installHooks(file, CMD)).toThrow(SettingsError);
		writeFileSync(file, '{ "hooks": [] }');
		expect(() => installHooks(file, CMD)).toThrow(SettingsError);
	});

	it("creates the settings directory when it is missing", () => {
		const nested = join(dir, "claude", "settings.json");
		installHooks(nested, CMD);
		expect(existsSync(nested)).toBe(true);
	});
});

describe("removeHooks", () => {
	it("removes only tracker entries after the user edited the file", () => {
		writeFileSync(file, USER);
		const r = installHooks(file, CMD);
		const s = json();
		s.model = "sonnet";
		s.hooks.Stop.push({ hooks: [{ type: "command", command: "second.sh" }] });
		writeFileSync(file, `${JSON.stringify(s, null, 2)}\n`);
		expect(removeHooks(file, { created: r.created })).toEqual({ removed: ALL });
		const after = json();
		expect(after.model).toBe("sonnet");
		expect(after.hooks.Stop.map((g: { hooks: { command: string }[] }) => g.hooks[0].command)).toEqual([
			"notify.sh",
			"second.sh",
		]);
		expect(after.hooks.PostToolUse).toEqual(JSON.parse(USER).hooks.PostToolUse);
		expect(Object.keys(after.hooks)).toEqual(["Stop", "PostToolUse"]);
	});

	it("drops the hooks key only when init created it", () => {
		const r = installHooks(file, CMD);
		removeHooks(file, { created: r.created });
		expect(json()).toEqual({});
		writeFileSync(file, '{ "hooks": {} }');
		const r2 = installHooks(file, CMD);
		expect(r2.created).not.toContain("hooks");
		removeHooks(file, { created: r2.created });
		expect(json()).toEqual({ hooks: {} });
	});

	it("keeps an event array the user created, emptied by the removal", () => {
		writeFileSync(file, '{ "hooks": { "Stop": [] } }');
		const r = installHooks(file, CMD);
		removeHooks(file, { created: r.created });
		expect(json()).toEqual({ hooks: { Stop: [] } });
	});

	it("without created info, drops what the removal emptied", () => {
		installHooks(file, CMD);
		expect(removeHooks(file).removed).toEqual(ALL);
		expect(json()).toEqual({});
	});

	it("keeps a matcher group that still holds user hooks", () => {
		writeFileSync(
			file,
			JSON.stringify({
				hooks: {
					Stop: [
						{
							hooks: [
								{ type: "command", command: "mine" },
								{ type: "command", command: `t ${HOOK_MARKER}` },
							],
						},
					],
				},
			}),
		);
		removeHooks(file);
		expect(json()).toEqual({ hooks: { Stop: [{ hooks: [{ type: "command", command: "mine" }] }] } });
	});

	it("does nothing for a missing file and refuses invalid JSON", () => {
		expect(removeHooks(file)).toEqual({ removed: [] });
		writeFileSync(file, "{ nope");
		expect(() => removeHooks(file)).toThrow(SettingsError);
		expect(read()).toBe("{ nope");
	});
});

describe("install then remove", () => {
	it.each([
		["Claude Code formatting", USER],
		["compact one-line file", '{"model":"opus","hooks":{"Stop":[{"hooks":[{"type":"command","command":"a"}]}]}}'],
		[
			"tabs, CRLF and BOM",
			'\uFEFF{\r\n\t"hooks": {\r\n\t\t"SessionEnd": [\r\n\t\t\t{ "hooks": [ { "type": "command", "command": "bye" } ] }\r\n\t\t]\r\n\t}\r\n}\r\n',
		],
		[
			"matcher groups, no trailing newline",
			'{\n    "hooks": {\n        "PreToolUse": [\n            { "matcher": "Bash", "hooks": [ { "type": "command", "command": "guard" } ] }\n        ]\n    }\n}',
		],
		["no hooks key", '{\n  "model": "opus"\n}\n'],
	])("gives back the original bytes by structural removal (%s)", (_name, original) => {
		writeFileSync(file, original);
		const r = installHooks(file, CMD);
		expect(() => JSON.parse(read().replace(/^\uFEFF/, ""))).not.toThrow();
		removeHooks(file, { created: r.created });
		expect(read()).toBe(original);
	});
});

describe("readSettingsBytes", () => {
	it("returns the bytes or null", () => {
		expect(readSettingsBytes(file)).toBeNull();
		writeFileSync(file, "{}");
		expect(readSettingsBytes(file)?.toString()).toBe("{}");
		expect(sha256(Buffer.from("{}"))).toMatch(/^[0-9a-f]{64}$/);
	});
});

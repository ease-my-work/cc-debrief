import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	ConfigError,
	configErrors,
	getConfigValue,
	loadCaptureConfig,
	loadConfig,
	setConfigValue,
	updateConfig,
} from "../../src/config";
import { configPath, ensureDir } from "../../src/paths";
import { type TmpHome, tmpHome } from "../helpers/tmp-home";

const DEFAULTS = {
	ai: {
		summaries: { enabled: true },
		maxPerDay: 50,
		review: { enabled: false, auto: false, autoThreshold: { turns: 20, tokens: 200000 }, maxPerDay: 10 },
		drafts: { enabled: false },
	},
	capture: { redact: ["@default"], maxFieldBytes: 32768, permissionHook: true },
	retention: { days: 90 },
	recap: { hiddenRepos: [] },
	budget: { monthlyUsd: null },
	pricing: { overrides: {} },
	dashboard: { port: 4242, pollSeconds: 15 },
};

let t: TmpHome;
beforeEach(() => {
	t = tmpHome();
});
afterEach(() => t.cleanup());

function writeConfig(value: unknown) {
	ensureDir(t.home);
	writeFileSync(configPath(), typeof value === "string" ? value : JSON.stringify(value));
}
const readConfigFile = () => JSON.parse(readFileSync(configPath(), "utf8"));

describe("loadConfig", () => {
	it("returns every feature 16 default when there is no file", () => {
		const cfg = loadConfig();
		expect(cfg).toEqual(DEFAULTS);
		expect(cfg.ai.model).toBeUndefined();
		expect(configErrors()).toEqual([]);
	});

	it("merges a sparse file over the defaults", () => {
		writeConfig({ retention: { days: 60 } });
		expect(loadConfig()).toEqual({ ...DEFAULTS, retention: { days: 60 } });
	});

	it("falls back per key for invalid values and reports them", () => {
		writeConfig({ retention: { days: -1 }, ai: { maxPerDay: 5 } });
		const cfg = loadConfig();
		expect(cfg.retention.days).toBe(90);
		expect(cfg.ai.maxPerDay).toBe(5);
		expect(configErrors().map((e) => e.key)).toEqual(["retention.days"]);
		expect(configErrors()[0].message).toBe("must be an integer between 0 and 3650");
	});

	it("uses defaults for an invalid JSON file and reports one (file) error", () => {
		writeConfig("{ not json");
		expect(loadConfig()).toEqual(DEFAULTS);
		const errors = configErrors();
		expect(errors).toHaveLength(1);
		expect(errors[0].key).toBe("(file)");
	});

	it("rejects an uncompilable capture.redact entry and a bad pollSeconds", () => {
		writeConfig({ capture: { redact: ["@default", "(unclosed"] }, dashboard: { pollSeconds: 3 } });
		const cfg = loadConfig();
		expect(cfg.capture.redact).toEqual(["@default"]);
		expect(cfg.dashboard.pollSeconds).toBe(15);
		expect(configErrors().map((e) => e.key)).toEqual(["capture.redact", "dashboard.pollSeconds"]);
	});

	it("ignores unknown keys", () => {
		writeConfig({ future: { flag: true }, retention: { days: 7, extra: 1 } });
		expect(loadConfig()).toEqual({ ...DEFAULTS, retention: { days: 7 } });
	});
});

describe("getConfigValue", () => {
	it("reads dotted keys from the effective config", () => {
		writeConfig({ ai: { review: { maxPerDay: 3 } } });
		expect(getConfigValue("ai.review.maxPerDay")).toBe(3);
		expect(getConfigValue("ai.review.autoThreshold")).toEqual({ turns: 20, tokens: 200000 });
		expect(getConfigValue("ai.model")).toBeUndefined();
	});

	it("throws ConfigError for an unknown key", () => {
		expect(() => getConfigValue("nope.key")).toThrow(ConfigError);
	});
});

describe("setConfigValue", () => {
	it("writes only the set key, sparse and nested", () => {
		const cfg = setConfigValue("ai.review.autoThreshold.turns", "30");
		expect(cfg.ai.review.autoThreshold).toEqual({ turns: 30, tokens: 200000 });
		expect(readConfigFile()).toEqual({ ai: { review: { autoThreshold: { turns: 30 } } } });
	});

	it("writes the file with mode 0600 on POSIX", () => {
		setConfigValue("retention.days", "60");
		if (process.platform !== "win32") expect(statSync(configPath()).mode & 0o777).toBe(0o600);
	});

	it("parses booleans, strings and JSON", () => {
		setConfigValue("ai.review.enabled", "true");
		setConfigValue("ai.model", "haiku");
		setConfigValue("capture.redact", String.raw`["@default","/\\bACME-[0-9A-F]{32}\\b/g"]`);
		setConfigValue("ai.review.autoThreshold", '{"turns":25}');
		expect(readConfigFile()).toEqual({
			ai: { review: { enabled: true, autoThreshold: { turns: 25 } }, model: "haiku" },
			capture: { redact: ["@default", String.raw`/\bACME-[0-9A-F]{32}\b/g`] },
		});
		expect(loadConfig().ai.review.autoThreshold).toEqual({ turns: 25, tokens: 200000 });
	});

	it("removes a key set to the empty string and prunes empty parents", () => {
		setConfigValue("ai.model", "haiku");
		setConfigValue("retention.days", "60");
		setConfigValue("ai.model", "");
		expect(readConfigFile()).toEqual({ retention: { days: 60 } });
		expect(loadConfig().ai.model).toBeUndefined();
	});

	it.each([
		["nope.key", "1"],
		["retention.days", "-1"],
		["retention.days", "ten"],
		["capture.redact", '["(unclosed"]'],
		["ai.review.autoThreshold", '{"turnz":1}'],
		["capture.redact.0", "x"],
	])("rejects %s = %s with ConfigError and leaves the file unchanged", (key, raw) => {
		writeConfig('{ "retention": { "days": 30 } }\n');
		const before = readFileSync(configPath());
		expect(() => setConfigValue(key, raw)).toThrow(ConfigError);
		expect(readFileSync(configPath())).toEqual(before);
	});

	it("writes nothing when rejected and there was no file", () => {
		expect(() => setConfigValue("retention.days", "-1")).toThrow(ConfigError);
		expect(existsSync(configPath())).toBe(false);
	});

	it("names the key and rule in the error message", () => {
		expect(() => setConfigValue("retention.days", "-1")).toThrow(
			"retention.days must be an integer between 0 and 3650",
		);
		expect(() => setConfigValue("nope.key", "1")).toThrow("unknown key nope.key");
	});

	it("preserves unknown keys already in the file", () => {
		writeConfig({ future: { flag: true }, retention: { days: 30 } });
		setConfigValue("ai.maxPerDay", "5");
		expect(readConfigFile()).toEqual({ future: { flag: true }, retention: { days: 30 }, ai: { maxPerDay: 5 } });
	});

	it("refuses to overwrite a config file that is not valid JSON", () => {
		writeConfig("{ not json");
		expect(() => setConfigValue("retention.days", "60")).toThrow(ConfigError);
		expect(readFileSync(configPath(), "utf8")).toBe("{ not json");
	});
});

describe("updateConfig", () => {
	it("applies several sets and unsets at once", () => {
		writeConfig({ ai: { model: "haiku" } });
		const cfg = updateConfig({ set: { "retention.days": 10, "dashboard.port": 5000 }, unset: ["ai.model"] });
		expect(cfg.retention.days).toBe(10);
		expect(readConfigFile()).toEqual({ retention: { days: 10 }, dashboard: { port: 5000 } });
	});

	it("rejects the whole patch when one value is invalid", () => {
		expect(() => updateConfig({ set: { "retention.days": 10, "dashboard.port": 80 } })).toThrow(ConfigError);
		expect(existsSync(configPath())).toBe(false);
	});
});

describe("recap.hiddenRepos (feature 17)", () => {
	it("defaults to an empty list", () => expect(loadConfig().recap.hiddenRepos).toEqual([]));
	it("accepts names that match no repo yet", () => {
		setConfigValue("recap.hiddenRepos", '["not-a-repo-yet","github.com/acme/secret"]');
		expect(loadConfig().recap.hiddenRepos).toEqual(["not-a-repo-yet", "github.com/acme/secret"]);
	});
	it("rejects more than 200 entries, an empty name and a name over 200 characters", () => {
		const many = JSON.stringify(Array.from({ length: 201 }, (_, i) => `r${i}`));
		for (const raw of [many, '[""]', JSON.stringify(["x".repeat(201)]), '"one"'])
			expect(() => setConfigValue("recap.hiddenRepos", raw)).toThrow(ConfigError);
		expect(existsSync(configPath())).toBe(false);
	});
});

describe("loadCaptureConfig", () => {
	it("returns capture defaults with no file", () => {
		expect(loadCaptureConfig()).toEqual({ redact: ["@default"], maxFieldBytes: 32768, permissionHook: true });
	});

	it("returns capture defaults for garbage values and never throws", () => {
		writeConfig({ capture: { redact: 5, maxFieldBytes: "x", permissionHook: "no" } });
		expect(loadCaptureConfig()).toEqual({ redact: ["@default"], maxFieldBytes: 32768, permissionHook: true });
		writeConfig("{ not json");
		expect(loadCaptureConfig()).toEqual({ redact: ["@default"], maxFieldBytes: 32768, permissionHook: true });
		writeConfig({ capture: "nope" });
		expect(loadCaptureConfig()).toEqual({ redact: ["@default"], maxFieldBytes: 32768, permissionHook: true });
	});

	it("keeps valid capture values when other keys are invalid", () => {
		writeConfig({ retention: { days: -1 }, capture: { redact: ["x"], maxFieldBytes: 2048, permissionHook: false } });
		expect(loadCaptureConfig()).toEqual({ redact: ["x"], maxFieldBytes: 2048, permissionHook: false });
	});

	it("rejects an out-of-range maxFieldBytes", () => {
		writeConfig({ capture: { maxFieldBytes: 10 } });
		expect(loadCaptureConfig().maxFieldBytes).toBe(32768);
	});
});

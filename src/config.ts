// config.json: sparse user settings merged over ConfigSchema defaults (feature 16).
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { CAPTURE_DEFAULTS, MAX_FIELD_BYTES, MAX_LIST } from "./capture-config";
import { configPath, ensureDir } from "./paths";
import { compilePattern } from "./redact";

export { loadCaptureConfig } from "./capture-config";

export class ConfigError extends Error {
	override name = "ConfigError";
	/** Every rejected key of a patch (PUT /api/config shows them under their controls); the message names the first. */
	constructor(
		message: string,
		readonly fields: { key: string; message: string }[] = [],
	) {
		super(message);
	}
}

const intIn = (min: number, max: number) => {
	const error = `must be an integer between ${min} and ${max}`;
	return z.number({ error }).int({ error }).min(min, { error }).max(max, { error });
};
const bool = () => z.boolean({ error: "must be true or false" });
// prefault({}) parses the empty object, so a missing section still gets its leaf defaults.
const obj = <T extends z.ZodRawShape>(shape: T) =>
	z.object(shape, { error: "must be an object" }).prefault({} as never);

const pollError = "must be 0 or an integer between 5 and 300";
const modelError = "must be 1-100 characters: letters, digits and . _ : [ ] -, starting with a letter or digit";

const redactList = z
	.array(z.string({ error: "must be a list of strings" }), { error: "must be a list of patterns" })
	.max(MAX_LIST, { error: `must have at most ${MAX_LIST} patterns` })
	.superRefine((list, ctx) => {
		for (const p of list) {
			if (p !== "@default" && compilePattern(p) === null) {
				ctx.addIssue({ code: "custom", message: `entry ${JSON.stringify(p)} is not a valid regular expression` });
			}
		}
	});

// Pricing overrides (Phase 7 P7): $ per million tokens per model id or family; prices 0-10,000.
const priceError = "must be a number between 0 and 10000 ($ per million tokens)";
const usdPerM = () => z.number({ error: priceError }).min(0, { error: priceError }).max(10_000, { error: priceError });
const overrideKeyError = "keys must be model ids or family names of 1-100 characters";
const overrideShapeError = "each override must be { input, output, cacheWrite?, cacheWrite1h?, cacheRead? }";
const PriceOverrideSchema = z.strictObject(
	{
		input: usdPerM(),
		output: usdPerM(),
		cacheWrite: usdPerM().optional(),
		cacheWrite1h: usdPerM().optional(),
		cacheRead: usdPerM().optional(),
	},
	{ error: overrideShapeError },
);

export const ConfigSchema = z.object({
	ai: obj({
		summaries: obj({ enabled: bool().default(true) }),
		maxPerDay: intIn(0, 1000).default(50),
		review: obj({
			enabled: bool().default(false),
			auto: bool().default(false),
			autoThreshold: obj({
				turns: intIn(1, 10_000).default(20),
				tokens: intIn(1000, 100_000_000).default(200_000),
			}),
			maxPerDay: intIn(0, 1000).default(10),
		}),
		drafts: obj({ enabled: bool().default(false) }),
		model: z
			.string({ error: modelError })
			.min(1, { error: modelError })
			.max(100, { error: modelError })
			.regex(/^[A-Za-z0-9][A-Za-z0-9._:[\]-]*$/, { error: modelError })
			.optional(),
	}),
	capture: obj({
		redact: redactList.default(CAPTURE_DEFAULTS.redact),
		maxFieldBytes: intIn(MAX_FIELD_BYTES.min, MAX_FIELD_BYTES.max).default(CAPTURE_DEFAULTS.maxFieldBytes),
		permissionHook: bool().default(CAPTURE_DEFAULTS.permissionHook),
	}),
	retention: obj({ days: intIn(0, 3650).default(90) }),
	recap: obj({
		hiddenRepos: z
			.array(z.string().min(1).max(200), { error: `must be a list of 1-200 character names` })
			.max(MAX_LIST, { error: `must have at most ${MAX_LIST} entries` })
			.default([]),
	}),
	budget: obj({
		monthlyUsd: z
			.number({ error: "must be a number between 0.01 and 1000000, or null to turn the budget off" })
			.min(0.01, { error: "must be a number between 0.01 and 1000000, or null to turn the budget off" })
			.max(1_000_000, { error: "must be a number between 0.01 and 1000000, or null to turn the budget off" })
			.nullable()
			.default(null),
	}),
	pricing: obj({
		overrides: z
			.record(
				z.string().min(1, { error: overrideKeyError }).max(100, { error: overrideKeyError }),
				PriceOverrideSchema,
				{ error: "must be an object of model id or family → prices" },
			)
			.default({}),
	}),
	dashboard: obj({
		port: intIn(1024, 65_535).default(4242),
		pollSeconds: z
			.number({ error: pollError })
			.int({ error: pollError })
			.refine((v) => v === 0 || (v >= 5 && v <= 300), { error: pollError })
			.default(15),
	}),
});

export type Config = z.output<typeof ConfigSchema>;
export type ConfigIssue = { key: string; message: string };
type Raw = Record<string, unknown>;

const isObject = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);

// Settings whose value is a map of user-chosen keys (Phase 7): `pricing.overrides.<model>` is settable, and the walks
// below treat the map as one leaf.
const RECORD_KEYS = new Set(["pricing.overrides"]);
const recordParent = (key: string): string | undefined => [...RECORD_KEYS].find((r) => key.startsWith(`${r}.`));

// Every settable dotted key: each object and leaf under the defaults, plus the optional ai.model.
const KNOWN_KEYS = new Set<string>(["ai.model"]);
(function walk(value: Raw, prefix: string) {
	for (const [k, v] of Object.entries(value)) {
		KNOWN_KEYS.add(prefix + k);
		if (isObject(v) && !RECORD_KEYS.has(prefix + k)) walk(v, `${prefix + k}.`);
	}
})(ConfigSchema.parse({}), "");

function unknownIn(key: string, value?: unknown): string | null {
	const parent = recordParent(key);
	if (parent) return key.slice(parent.length + 1).includes(".") ? key : null;
	if (!KNOWN_KEYS.has(key)) return key;
	if (RECORD_KEYS.has(key)) return null;
	if (isObject(value)) {
		for (const [k, v] of Object.entries(value)) {
			const bad = unknownIn(`${key}.${k}`, v);
			if (bad) return bad;
		}
	}
	return null;
}

function assertKnown(key: string, value?: unknown): void {
	const bad = unknownIn(key, value);
	if (bad) throw new ConfigError(`unknown key ${bad}`, [{ key: bad, message: "unknown key" }]);
}

function getPath(root: unknown, key: string): unknown {
	let cur = root;
	for (const part of key.split(".")) cur = isObject(cur) ? cur[part] : undefined;
	return cur;
}

function setPath(root: Raw, key: string, value: unknown): void {
	const parts = key.split(".");
	let cur = root;
	for (const part of parts.slice(0, -1)) {
		if (!isObject(cur[part])) cur[part] = {};
		cur = cur[part] as Raw;
	}
	cur[parts[parts.length - 1]] = value;
}

// Removes the key, then any parent objects the removal left empty.
function deletePath(root: Raw, key: string): void {
	const parts = key.split(".");
	const chain: Raw[] = [root];
	for (const part of parts.slice(0, -1)) {
		const next = chain[chain.length - 1][part];
		if (!isObject(next)) return;
		chain.push(next);
	}
	delete chain[chain.length - 1][parts[parts.length - 1]];
	for (let i = chain.length - 1; i > 0; i--) {
		if (Object.keys(chain[i]).length > 0) break;
		delete chain[i - 1][parts[i - 1]];
	}
}

function readRaw(): { raw: Raw; error?: string } {
	let text: string;
	try {
		text = readFileSync(configPath(), "utf8");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return { raw: {} };
		return { raw: {}, error: `cannot read config.json: ${(e as Error).message}` };
	}
	try {
		const value: unknown = JSON.parse(text);
		return isObject(value) ? { raw: value } : { raw: {}, error: "config.json must hold a JSON object" };
	} catch (e) {
		return { raw: {}, error: `config.json is not valid JSON: ${(e as Error).message}` };
	}
}

// Parses raw over the defaults; each invalid key falls back to its default and is reported.
function resolve(raw: Raw): { config: Config; errors: ConfigIssue[] } {
	const input = structuredClone(raw);
	const errors: ConfigIssue[] = [];
	for (;;) {
		const result = ConfigSchema.safeParse(input);
		if (result.success) return { config: result.data, errors };
		const seen = new Set<string>();
		for (const issue of result.error.issues) {
			const parts: string[] = [];
			for (const p of issue.path) {
				if (typeof p !== "string") break; // array index: report the list key
				parts.push(p);
			}
			let key = parts.join(".");
			// A bad entry of a map setting falls back as a whole (deleting one of its fields could leave it still invalid).
			const parent = recordParent(key);
			if (parent) key = `${parent}.${parts[parent.split(".").length]}`;
			if (key === "")
				return { config: ConfigSchema.parse({}), errors: [...errors, { key: "(file)", message: issue.message }] };
			if (seen.has(key)) continue;
			seen.add(key);
			errors.push({ key, message: issue.message });
			deletePath(input, key);
		}
	}
}

export function loadConfig(): Config {
	return resolve(readRaw().raw).config;
}

export function configErrors(): ConfigIssue[] {
	const { raw, error } = readRaw();
	return error ? [{ key: "(file)", message: error }] : resolve(raw).errors;
}

/** Dotted keys in config.json that no setting uses (kept on write, ignored); an unknown object is one key. */
export function unknownConfigKeys(): string[] {
	const out: string[] = [];
	(function walk(value: Raw, prefix: string) {
		for (const [k, v] of Object.entries(value)) {
			const key = prefix + k;
			if (!KNOWN_KEYS.has(key)) out.push(key);
			else if (isObject(v) && !RECORD_KEYS.has(key)) walk(v, `${key}.`);
		}
	})(readRaw().raw, "");
	return out;
}

/** The settable leaf keys the user has set in config.json (objects are walked; unknown keys are left out). */
export function explicitConfigKeys(): string[] {
	const out: string[] = [];
	(function walk(value: Raw, prefix: string) {
		for (const [k, v] of Object.entries(value)) {
			const key = prefix + k;
			if (!KNOWN_KEYS.has(key)) continue;
			if (isObject(v) && !RECORD_KEYS.has(key)) walk(v, `${key}.`);
			else out.push(key);
		}
	})(readRaw().raw, "");
	return out;
}

/** Value of a dotted key in the effective config; throws ConfigError for an unknown key. */
export function getConfigValue(key: string): unknown {
	assertKnown(key);
	return getPath(loadConfig(), key);
}

function writeRaw(raw: Raw): void {
	const path = configPath();
	ensureDir(dirname(path));
	const tmp = `${path}.${process.pid}.tmp`;
	try {
		writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
		renameSync(tmp, path);
	} catch (e) {
		rmSync(tmp, { force: true });
		throw e;
	}
}

/** Applies several changes at once; any invalid change rejects the whole patch and writes nothing. */
export function updateConfig(patch: { set?: Record<string, unknown>; unset?: string[] }): Config {
	const { raw, error } = readRaw();
	if (error) throw new ConfigError(`${error} (${configPath()}); fix or delete the file first`);
	const next = structuredClone(raw);
	const touched: string[] = [];
	for (const [key, value] of Object.entries(patch.set ?? {})) {
		assertKnown(key, value);
		setPath(next, key, value);
		touched.push(key);
	}
	for (const key of patch.unset ?? []) {
		assertKnown(key);
		deletePath(next, key);
		touched.push(key);
	}
	const { config, errors } = resolve(next);
	// Invalid values the user already had elsewhere in the file do not block an unrelated change.
	const bad = errors.filter((e) =>
		touched.some((k) => k === e.key || k.startsWith(`${e.key}.`) || e.key.startsWith(`${k}.`)),
	);
	if (bad.length > 0) throw new ConfigError(`${bad[0].key} ${bad[0].message}`, bad);
	writeRaw(next);
	return config;
}

// CLI value syntax (feature 16): true/false, numbers, JSON for [ or {, else a string.
function parseValue(key: string, raw: string): unknown {
	if (raw === "true") return true;
	if (raw === "false") return false;
	if (raw === "null") return null;
	if (/^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(raw)) return Number(raw);
	if (raw.startsWith("[") || raw.startsWith("{")) {
		try {
			return JSON.parse(raw);
		} catch (e) {
			throw new ConfigError(`${key} is not valid JSON: ${(e as Error).message}`);
		}
	}
	return raw;
}

/** Sets one dotted key from its CLI text; "" removes the key so its default applies. */
export function setConfigValue(key: string, raw: string): Config {
	if (raw === "") return updateConfig({ unset: [key] });
	return updateConfig({ set: { [key]: parseValue(key, raw) } });
}

// Fixture scrubbing: replaces private names by mapping, redacts secrets and emails, and finds leaks.
// The private map lives at ~/.cc-debrief-spike/scrub-map.json and is never committed.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { findSessionFiles } from "./jsonl.mjs";
import { spikeHome } from "./paths.mjs";
import { compilePattern, DEFAULT_REDACT } from "./redact.mjs";

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const jsonEscape = (s) => JSON.stringify(s).slice(1, -1);
// The local part may not start right after a backslash: in raw JSON "\n@RTK.md" would otherwise read as "n@RTK.md".
// An address glued to an escape is still caught when decoded string leaves are scrubbed and checked.
const EMAIL = /(?<![\\A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const SAFE_EMAIL = "user@example.com";

// Case-insensitive; alphanumeric neighbours block a match so short names do not hit inside identifiers.
const termRe = (s) => new RegExp(`(?<![A-Za-z0-9])${escapeRe(s)}(?![A-Za-z0-9])`, "gi");

// [needle: RegExp, replacement: string][] in application order: home path forms (longest first), emails,
// `replace` terms (longest first), then the bare username, so a longer form is never pre-empted.
export function buildReplacements(map) {
	const pairs = [];
	const add = (needle, replacement, rank) => {
		if (needle) pairs.push({ needle, replacement, rank });
	};
	if (map.home) {
		const home = map.home.replace(/[\\/]+$/, "");
		const win = /^[A-Za-z]:\\/.test(home);
		const target = win ? "C:\\Users\\user" : home.startsWith("/Users/") ? "/Users/user" : "/home/user";
		const forms = new Map([[home, target]]);
		if (win) {
			const fwd = home.replace(/\\/g, "/");
			forms.set(jsonEscape(home), jsonEscape(target));
			forms.set(fwd, "C:/Users/user");
			forms.set(`/${home[0].toLowerCase()}${fwd.slice(2)}`, "/c/Users/user");
		}
		forms.set(home.replace(/[^A-Za-z0-9]/g, "-"), target.replace(/[^A-Za-z0-9]/g, "-"));
		for (const [from, to] of forms) add(new RegExp(`${escapeRe(from)}(?![A-Za-z0-9])`, "gi"), to, [0, -from.length]);
	}
	for (const email of map.emails ?? []) add(new RegExp(escapeRe(email), "gi"), SAFE_EMAIL, [1, -email.length]);
	for (const [from, to] of Object.entries(map.replace ?? {})) {
		add(termRe(from), to, [2, -from.length]);
		const esc = jsonEscape(from);
		if (esc !== from) add(termRe(esc), jsonEscape(to), [2, -esc.length]);
	}
	if (map.username) add(termRe(map.username), "user", [3, 0]);
	return pairs.sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1]).map((p) => [p.needle, p.replacement]);
}

// Links to the user's own claude.ai artifacts; `{id}` placeholders in tool docs are left alone.
const ARTIFACT_URL = /(claude\.ai\/(?:code\/)?artifact\/)(?!example-artifact\b)[A-Za-z0-9_-]{8,}/g;

export function scrubText(text, replacements, patterns) {
	let out = text;
	for (const [needle, replacement] of replacements) out = out.replace(needle, replacement);
	for (const re of patterns) out = out.replace(re, "[REDACTED]");
	out = out.replace(ARTIFACT_URL, "$1example-artifact");
	return out.replace(EMAIL, (m) => (m.toLowerCase().endsWith("@example.com") ? m : SAFE_EMAIL));
}

// Account identifiers (e.g. the `credential_org` attachment) are not names, so no map term catches them.
const ACCOUNT_ID_KEY = /^(organizationUuid|accountUuid|organization_uuid|account_uuid)$/;
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

function scrubDeep(value, replacements, patterns) {
	if (typeof value === "string") return scrubText(value, replacements, patterns);
	if (Array.isArray(value)) return value.map((v) => scrubDeep(v, replacements, patterns));
	if (value && typeof value === "object") {
		const out = {};
		for (const [k, v] of Object.entries(value))
			out[scrubText(k, replacements, patterns)] =
				ACCOUNT_ID_KEY.test(k) && typeof v === "string" ? ZERO_UUID : scrubDeep(v, replacements, patterns);
		return out;
	}
	return value;
}

// Scrubs one JSON document: raw text first (covers keys and escaped paths), then decoded string leaves
// (covers secrets that are JSON-escaped inside message text). Throws if the result is not valid JSON.
export function scrubJson(text, replacements, patterns) {
	let parsed;
	try {
		parsed = JSON.parse(scrubText(text, replacements, patterns));
	} catch {
		parsed = JSON.parse(text); // raw-text scrub broke the JSON; fall back to leaves only
	}
	const out = JSON.stringify(scrubDeep(parsed, replacements, patterns));
	JSON.parse(out);
	return out;
}

const HOME_PATHS = [
	/[A-Za-z]:(?:\\{1,2}|\/)Users(?:\\{1,2}|\/)(?!user\b)[\w.-]+/gi,
	/\/home\/(?!user\b)\w+/g,
	/\/Users\/(?!user\b)\w+/g,
	/[A-Za-z]--Users-(?!user\b)[\w.]+/gi,
];

export function findLeaks(text, { replacements = [], patterns = [] } = {}) {
	const leaks = [];
	const scan = (kind, re, keep = () => true) => {
		re.lastIndex = 0;
		for (const m of text.matchAll(new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`))) {
			if (!keep(m[0])) continue;
			const start = Math.max(0, m.index - 10);
			leaks.push({ kind, sample: text.slice(start, Math.min(text.length, start + 40)) });
		}
	};
	for (const [needle] of replacements) scan("map-term", needle);
	for (const re of HOME_PATHS) scan("home-path", re);
	scan("email", EMAIL, (m) => !m.toLowerCase().endsWith("@example.com"));
	for (const re of patterns) scan("secret", re, (m) => !m.startsWith("[REDACTED]"));
	scan("artifact-url", ARTIFACT_URL);
	scan(
		"account-id",
		/"(?:organizationUuid|accountUuid|organization_uuid|account_uuid)"\s*:\s*"[^"]+"/g,
		(m) => !m.includes(ZERO_UUID),
	);
	return leaks;
}

// Copies one session (main + subagent files) into destDir, scrubbed line by line, and writes case.json.
export function scrubFixture({ sessionId, projectsDir, destDir, map, surface, os, caseName, covers, patterns }) {
	const replacements = buildReplacements(map);
	const pats = patterns ?? DEFAULT_REDACT.map(compilePattern);
	const files = findSessionFiles(projectsDir, sessionId);
	const main = files.find((f) => f.agentId === null);
	if (!main) throw new Error(`no transcript for ${sessionId}`);
	const sessionRoot = dirname(main.path);
	let lines = 0;
	let written = 0;
	let ccVersion = null;
	const copy = (src, isJsonl) => {
		const dest = join(destDir, relative(sessionRoot, src));
		mkdirSync(dirname(dest), { recursive: true });
		const text = readFileSync(src, "utf8");
		if (isJsonl) {
			const out = [];
			for (const raw of text.split("\n")) {
				if (!raw.trim()) continue;
				const line = scrubJson(raw, replacements, pats);
				if (ccVersion === null) ccVersion = JSON.parse(line).version ?? null;
				out.push(line);
				lines++;
			}
			writeFileSync(dest, `${out.join("\n")}\n`);
		} else {
			writeFileSync(dest, `${JSON.stringify(JSON.parse(scrubJson(text, replacements, pats)), null, 2)}\n`);
		}
		written++;
	};
	for (const f of files) {
		copy(f.path, true);
		if (f.metaPath) copy(f.metaPath, false);
	}
	writeFileSync(
		join(destDir, "case.json"),
		`${JSON.stringify({ surface, os, ccVersion, covers, case: caseName, sessionId, scrubbedAt: new Date().toISOString() }, null, 2)}\n`,
	);
	return { files: written, lines };
}

// The private map from ~/.cc-debrief-spike/scrub-map.json, or null when it does not exist.
export function loadScrubMap(env = process.env) {
	try {
		return JSON.parse(readFileSync(join(spikeHome(env), "scrub-map.json"), "utf8"));
	} catch (e) {
		if (e.code === "ENOENT") return null;
		throw e;
	}
}

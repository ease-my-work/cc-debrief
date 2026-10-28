// Fails (exit 1) if any committed fixture under test/fixtures/ (except _raw/) contains a home path,
// email, secret, or a term from the private scrub map. JSON files are also checked on decoded strings.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { compilePattern, DEFAULT_REDACT } from "./lib/redact.mjs";
import { buildReplacements, findLeaks, loadScrubMap } from "./lib/scrub.mjs";

const root = join(import.meta.dirname, "..", "test", "fixtures");
const map = loadScrubMap();
const opts = { replacements: map ? buildReplacements(map) : [], patterns: DEFAULT_REDACT.map(compilePattern) };

function* walk(dir) {
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isDirectory()) {
			if (e.name !== "_raw") yield* walk(p);
		} else yield p;
	}
}

function strings(value, out) {
	if (typeof value === "string") out.push(value);
	else if (Array.isArray(value)) for (const v of value) strings(v, out);
	else if (value && typeof value === "object")
		for (const [k, v] of Object.entries(value)) {
			out.push(k);
			strings(v, out);
		}
	return out;
}

function decoded(file, text) {
	const docs = [];
	if (file.endsWith(".jsonl")) {
		for (const line of text.split("\n"))
			if (line.trim())
				try {
					docs.push(JSON.parse(line));
				} catch {}
	} else if (file.endsWith(".json")) {
		try {
			docs.push(JSON.parse(text));
		} catch {}
	}
	return docs.flatMap((d) => strings(d, [])).join("\n");
}

const leaks = [];
let files = 0;
if (existsSync(root) && statSync(root).isDirectory()) {
	for (const file of walk(root)) {
		files++;
		const text = readFileSync(file, "utf8");
		const found = [...findLeaks(text, opts), ...findLeaks(decoded(file, text), opts)];
		const unique = new Map(found.map((l) => [`${l.kind}|${l.sample}`, l]));
		for (const l of unique.values()) leaks.push({ file: relative(root, file), ...l });
	}
}

if (!map) console.warn("note: no ~/.cc-debrief-spike/scrub-map.json; map-term checks skipped");
if (leaks.length) {
	for (const l of leaks) console.error(`${l.file}: ${l.kind}: ${JSON.stringify(l.sample)}`);
	console.error(`${leaks.length} leak(s) in ${files} fixture files`);
	process.exit(1);
}
console.log(`fixtures clean: ${files} files checked`);

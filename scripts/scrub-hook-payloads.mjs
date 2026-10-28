// Turns raw dump-hook records into test/fixtures/hooks/<surface>/<event>[-<source|exit_reason>].json
// (payload only, scrubbed). The first dump per name wins.
// Usage: node scripts/scrub-hook-payloads.mjs --surface <s> [--entrypoint <CLAUDE_CODE_ENTRYPOINT>] [--since <iso>]
//          [--cwd-includes <text>]   only payloads whose cwd contains <text> (e.g. the scratch repo name)
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rawDir } from "./lib/paths.mjs";
import { compilePattern, DEFAULT_REDACT } from "./lib/redact.mjs";
import { buildReplacements, loadScrubMap, scrubJson } from "./lib/scrub.mjs";

const args = process.argv.slice(2);
const opt = (name) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
};
const surface = opt("--surface");
const entrypoint = opt("--entrypoint");
const since = opt("--since");
const cwdIncludes = opt("--cwd-includes");
if (!["cli", "vscode", "desktop"].includes(surface)) {
	console.error(
		"usage: node scripts/scrub-hook-payloads.mjs --surface cli|vscode|desktop [--entrypoint <v>] [--since <iso>]",
	);
	process.exit(2);
}
const map = loadScrubMap();
if (!map) {
	console.error("missing ~/.cc-debrief-spike/scrub-map.json (see scripts/scrub-map.example.json)");
	process.exit(1);
}
const replacements = buildReplacements(map);
const patterns = DEFAULT_REDACT.map(compilePattern);

const RECORD =
	/^(SessionStart|Stop|PermissionRequest|SessionEnd|StopFailure|unknown)(-[A-Za-z0-9_]+)?-\d{8}T\d{9}-\d+\.json$/;
const files = readdirSync(rawDir())
	.filter((f) => RECORD.test(f))
	.sort((a, b) => a.replace(/^.*?(\d{8}T\d{9}).*$/, "$1").localeCompare(b.replace(/^.*?(\d{8}T\d{9}).*$/, "$1")));

const destDir = join(import.meta.dirname, "..", "test", "fixtures", "hooks", surface);
mkdirSync(destDir, { recursive: true });
const written = [];
const seen = new Set();
for (const f of files) {
	const rec = JSON.parse(readFileSync(join(rawDir(), f), "utf8"));
	if (!rec.payload) continue;
	if (since && rec.receivedAt < since) continue;
	if (entrypoint && rec.env?.values?.CLAUDE_CODE_ENTRYPOINT !== entrypoint) continue;
	if (cwdIncludes && !String(rec.payload.cwd ?? "").includes(cwdIncludes)) continue;
	const p = rec.payload;
	const q = rec.event === "SessionStart" ? p.source : rec.event === "SessionEnd" ? (p.exit_reason ?? p.reason) : null;
	const name = `${rec.event}${q ? `-${String(q).replace(/[^A-Za-z0-9_]/g, "_")}` : ""}.json`;
	if (seen.has(name)) continue;
	seen.add(name);
	const dest = join(destDir, name);
	if (existsSync(dest)) continue; // keep what is already committed
	writeFileSync(dest, `${JSON.stringify(JSON.parse(scrubJson(JSON.stringify(p), replacements, patterns)), null, 2)}\n`);
	written.push(name);
}
console.log(`wrote ${written.length} payloads to ${destDir}: ${written.join(", ") || "none"}`);

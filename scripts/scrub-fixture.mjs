// Copies one real session into test/fixtures/transcripts/<surface>/<case>/, scrubbed.
// Usage: node scripts/scrub-fixture.mjs --session <id> --surface cli|vscode|desktop --os windows|linux
//          --case <name> --covers a,b,c
import { rmSync } from "node:fs";
import { join } from "node:path";
import { projectsDir } from "./lib/paths.mjs";
import { loadScrubMap, scrubFixture } from "./lib/scrub.mjs";

const args = process.argv.slice(2);
const opt = (name) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
};
const sessionId = opt("--session");
const surface = opt("--surface");
const os = opt("--os");
const caseName = opt("--case");
const covers = (opt("--covers") ?? "").split(",").filter(Boolean);

if (
	!sessionId ||
	!["cli", "vscode", "desktop"].includes(surface) ||
	!["windows", "linux", "macos"].includes(os) ||
	!caseName
) {
	console.error(
		"usage: node scripts/scrub-fixture.mjs --session <id> --surface cli|vscode|desktop --os windows|linux --case <name> --covers a,b,c",
	);
	process.exit(2);
}
if (!/^[a-z0-9-]+$/.test(caseName)) {
	console.error("--case must be lowercase letters, digits and dashes");
	process.exit(2);
}
const map = loadScrubMap();
if (!map) {
	console.error("missing ~/.cc-debrief-spike/scrub-map.json (see scripts/scrub-map.example.json)");
	process.exit(1);
}

const destDir = join(import.meta.dirname, "..", "test", "fixtures", "transcripts", surface, caseName);
rmSync(destDir, { recursive: true, force: true });
const r = scrubFixture({ sessionId, projectsDir: projectsDir(), destDir, map, surface, os, caseName, covers });
console.log(`wrote ${r.files} files, ${r.lines} lines to ${destDir}`);
console.log("Next: npm run fixtures:check, then skim the files by eye before committing.");

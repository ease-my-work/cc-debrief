// Runs the recap tests once per time zone (Phase 6 plan, Global Constraints). Node reads TZ only at process start,
// so each zone is its own vitest process. Extra arguments are passed to vitest; exits 1 if any zone fails.
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const ZONES = ["UTC", "Asia/Kolkata", "America/Los_Angeles"];
const vitest = join(import.meta.dirname, "..", "node_modules", "vitest", "vitest.mjs");
const args =
	process.argv.length > 2
		? process.argv.slice(2)
		: ["test/unit/recap", "test/unit/parity", "test/unit/commands-digest.test.ts"];
let failed = 0;
for (const tz of ZONES) {
	console.log(`\n── TZ=${tz}`);
	const r = spawnSync(process.execPath, [vitest, "run", "--project", "node", ...args], {
		stdio: "inherit",
		env: { ...process.env, TZ: tz },
	});
	if (r.status !== 0) failed++;
}
process.exit(failed ? 1 : 0);

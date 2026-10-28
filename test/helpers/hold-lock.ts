// Child script (bundled with bundleScript): takes the session lock, prints "locked", holds it for N ms.
// Usage: node hold-lock.mjs <sessionId> <holdMs>
import { withSessionLock } from "../../src/locks";

const [sessionId, holdMs] = process.argv.slice(2);
const result = await withSessionLock(sessionId, { waitMs: 0 }, async () => {
	process.stdout.write("locked\n");
	await new Promise((r) => setTimeout(r, Number(holdMs)));
	return "done";
});
process.stdout.write(`${result}\n`);

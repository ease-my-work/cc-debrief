import { type Command, Option } from "commander";
import { snapshotSession } from "../enrich";
import { checkSessionId, quietly, withDb } from "./common";

export function registerSnapshotCommand(program: Command): void {
	program
		.command("snapshot", { hidden: true })
		.description("record git state at session start (run by the SessionStart hook)")
		.argument("<session_id>")
		.option("--cwd <path>", "the session's working directory (default: this process's)")
		.addOption(new Option("--from-hook", "run quietly as the hook's worker").hideHelp())
		.action(async (id: string, opts: { cwd?: string; fromHook?: boolean }) => {
			await quietly("snapshot", opts.fromHook, async () => {
				const sessionId = checkSessionId(id);
				await withDb((db) => snapshotSession(db, sessionId, opts.cwd ?? process.cwd()));
			});
		});
}

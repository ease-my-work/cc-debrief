import { Command, CommanderError } from "commander";
import { SettingsError } from "./claude/settings";
import { ExitCode, UsageError } from "./commands/common";
import { registerConfigCommand } from "./commands/config";
import { registerDashboardCommand } from "./commands/dashboard";
import { registerDigestCommand } from "./commands/digest";
import { registerDoctorCommand } from "./commands/doctor";
import { registerEnrichCommand } from "./commands/enrich";
import { registerExportCommand } from "./commands/export";
import { registerIngestCommand } from "./commands/ingest";
import { registerInitCommand } from "./commands/init";
import { registerPurgeCommand } from "./commands/purge";
import { registerRebuildCommand } from "./commands/rebuild";
import { registerRecapCommand } from "./commands/recap";
import { registerScanCommand } from "./commands/scan";
import { registerSnapshotCommand } from "./commands/snapshot";
import { registerUninitCommand } from "./commands/uninit";
import { ConfigError } from "./config";
import { VERSION } from "./version";

export function createProgram(): Command {
	// exitOverride before any .command() so subcommands inherit it; runCli maps the result to an exit code.
	const program = new Command("cc-debrief")
		.description("Local session tracker and coach for Claude Code")
		.version(VERSION)
		.exitOverride();
	registerInitCommand(program);
	registerUninitCommand(program);
	registerDoctorCommand(program);
	registerIngestCommand(program);
	registerEnrichCommand(program);
	registerSnapshotCommand(program);
	registerScanCommand(program);
	registerDashboardCommand(program);
	registerExportCommand(program);
	registerPurgeCommand(program);
	registerRebuildCommand(program);
	registerRecapCommand(program);
	registerDigestCommand(program);
	registerConfigCommand(program);
	return program;
}

/**
 * Runs the CLI on args (without node and script path) and returns the exit code: 0 ok, 1 runtime failure, 2 usage
 * or validation, 3 settings.json refused (feature 13 exit codes).
 */
export async function runCli(args: string[]): Promise<number> {
	try {
		await createProgram().parseAsync(args, { from: "user" });
		return 0;
	} catch (e) {
		// Commander has already printed its own message (help, version or usage error).
		if (e instanceof CommanderError) return e.exitCode === 0 ? 0 : 2;
		if (e instanceof ExitCode) return e.code; // the command printed its own result
		process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
		if (e instanceof ConfigError || e instanceof UsageError) return 2;
		return e instanceof SettingsError ? 3 : 1;
	}
}

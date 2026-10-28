import type { Command } from "commander";
import { getConfigValue, loadConfig, setConfigValue } from "../config";

const out = (line: string) => process.stdout.write(`${line}\n`);
const show = (value: unknown) => (value === undefined ? "unset" : JSON.stringify(value));

export function registerConfigCommand(program: Command): void {
	const config = program.command("config").description("show or change settings in config.json");

	config
		.command("get")
		.description("print the effective config, or one dotted key, as JSON")
		.argument("[key]", "dotted key, e.g. ai.maxPerDay")
		.action((key?: string) => {
			if (key === undefined) out(JSON.stringify(loadConfig(), null, 2));
			else out(JSON.stringify(getConfigValue(key) ?? null));
		});

	config
		.command("set")
		.description('set a dotted key; "" removes it so the default applies')
		.argument("<key>", "dotted key, e.g. retention.days")
		.argument("<value>", "true/false, a number, JSON starting with [ or {, or a string")
		.action((key: string, raw: string) => {
			const before = getConfigValue(key);
			const cfg = setConfigValue(key, raw);
			const after = getConfigValue(key);
			if (raw === "") {
				out(key === "ai.model" ? "ai.model unset (Claude Code default)" : `${key} unset (default ${show(after)})`);
			} else {
				out(`${key} = ${show(after)}   (was ${show(before)})`);
			}
			if (key === "capture.permissionHook" && before !== after) {
				out(
					after === false
						? "Permission prompts are no longer recorded. Run `cc-debrief init` to remove the hook entry as well."
						: "Permission prompts will be recorded once the hook entry is back. Run `cc-debrief init` to add it.",
				);
			}
			if (key.startsWith("ai.review") && cfg.ai.review.auto && !cfg.ai.review.enabled) {
				process.stderr.write("warning: ai.review.auto has no effect while ai.review.enabled is false\n");
			}
		});
}

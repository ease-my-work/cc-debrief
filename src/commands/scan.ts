import { resolve } from "node:path";
import type { Command } from "commander";
import { repoInfo } from "../collector/git";
import type { InventoryItem } from "../collector/inventory";
import { upsertRepo } from "../db/queries/repos";
import { scanRepoInto, scanUserInto } from "../derive/inventory-usage";
import { count, type Out, stdout, tilde, withDb } from "./common";

const of = (items: InventoryItem[], kind: InventoryItem["kind"], scope?: InventoryItem["scope"]) =>
	items.filter((i) => i.kind === kind && (scope === undefined || i.scope === scope)).length;

/** init's summary: "6 user skills, 2 plugins, 3 MCP servers, 1 hook set". */
export function inventoryLine(items: InventoryItem[]): string {
	return [
		count(of(items, "skill", "user"), "user skill"),
		count(of(items, "plugin"), "plugin"),
		count(of(items, "mcp"), "MCP server"),
		count(of(items, "hook"), "hook set"),
	].join(", ");
}

/** cc-debrief scan [path] (feature 13): user level, plus the git repo holding path (default: the working dir). */
export async function runScan(opts: { path?: string; out?: Out; now?: Date } = {}): Promise<void> {
	const out = opts.out ?? stdout;
	const now = opts.now ?? new Date();
	const path = resolve(opts.path ?? process.cwd());
	const info = await repoInfo(path);
	await withDb((db) => {
		const repoId = info ? upsertRepo(db, info) : null;
		const user = scanUserInto(db, now);
		out(
			`user   ${[
				count(of(user, "skill", "user"), "skill"),
				count(of(user, "skill", "plugin"), "plugin skill"),
				count(of(user, "plugin"), "plugin"),
				count(of(user, "mcp"), "MCP server"),
				count(of(user, "hook"), "hook set"),
			].join(" · ")}`,
		);
		if (!info || !repoId) {
			out(`repo   not a git repo: ${tilde(path)} (user level only)`);
			return;
		}
		const repo = scanRepoInto(db, info.root, repoId, now);
		const skills = repo.filter((i) => i.kind === "skill");
		const lazy = skills.filter((i) => i.meta.load === "lazy").length;
		out(
			`repo   ${info.name}: ${count(skills.length, "skill")}${lazy > 0 ? ` (${lazy} lazy)` : ""} · ${count(
				of(repo, "mcp"),
				"MCP server",
			)} · ${count(of(repo, "hook"), "hook")}`,
		);
	});
}

export function registerScanCommand(program: Command): void {
	program
		.command("scan")
		.description("rescan installed skills, plugins, MCP servers and hooks (read-only)")
		.argument("[path]", "also scan the git repo holding this path (default: the current directory)")
		.action(async (path?: string) => {
			await runScan({ path });
		});
}

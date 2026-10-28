// `cc-debrief digest` (Phase 7 P15, feature 13): ingest (no AI) unless --no-ingest, then the spend and coaching digest
// for the last 7 or 30 days as text, Markdown or JSON. Bad --days or --format values are usage errors (exit 2).
import { type Command, InvalidArgumentError } from "commander";
import { loadConfig } from "../config";
import type { Db } from "../db/adapter";
import { buildTerminalDigest, formatDigestMarkdown, formatDigestText } from "../digest/terminal";
import { ingestPending } from "../ingest/ingest";
import { type Out, stdout, withDb } from "./common";

export type DigestOptions = {
	days?: 7 | 30;
	format?: "text" | "md" | "json";
	repo?: string;
	noIngest?: boolean;
	/** Test seam; default ingestPending(). */
	ingest?: (db: Db) => unknown;
	out?: Out;
	now?: Date;
};

export async function runDigest(o: DigestOptions = {}): Promise<void> {
	const out = o.out ?? stdout;
	await withDb((db) => {
		if (!o.noIngest) (o.ingest ?? ingestPending)(db);
		const d = buildTerminalDigest(db, loadConfig(), { days: o.days ?? 7, repo: o.repo, now: o.now ?? new Date() });
		const format = o.format ?? "text";
		out(
			format === "json" ? JSON.stringify(d, null, 2) : format === "md" ? formatDigestMarkdown(d) : formatDigestText(d),
		);
	});
}

function parseDays(value: string): 7 | 30 {
	if (value === "7" || value === "30") return Number(value) as 7 | 30;
	throw new InvalidArgumentError("must be 7 or 30");
}
function parseFormat(value: string): "text" | "md" | "json" {
	if (value === "text" || value === "md" || value === "json") return value;
	throw new InvalidArgumentError("must be text, md or json");
}

export function registerDigestCommand(program: Command): void {
	program
		.command("digest")
		.description("spend, top repos, budget pace, spikes, cache hit rate and coaching for the last 7 or 30 days (no AI)")
		.option("--days <n>", "7 (default) or 30", parseDays)
		.option("--format <f>", "text (default), md or json", parseFormat)
		.option("--repo <id>", "one repo only")
		.option("--no-ingest", "skip reading new transcript lines first")
		.action(async (opts: DigestOptions & { ingest?: boolean }) => {
			const { ingest, ...rest } = opts;
			await runDigest({ ...rest, noIngest: ingest === false });
		});
}

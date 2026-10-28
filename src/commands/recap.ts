// `cc-debrief recap` (feature 13, feature 17): ingest (no AI) unless --no-ingest, then the recap for one range as text,
// Markdown or JSON on stdout. Range errors and conflicting flags are usage errors (exit 2).
import type { Command } from "commander";
import { loadConfig } from "../config";
import type { Db } from "../db/adapter";
import { ingestPending } from "../ingest/ingest";
import { buildRecap } from "../recap/build";
import { formatMarkdown, formatText } from "../recap/format";
import { estimatePolishCost, PolishError, polishRecap } from "../recap/polish";
import { RecapRangeError, resolveRange } from "../recap/range";
import type { PolishedRecap, RangeInput, Recap } from "../recap/types";
import { type Out, stdout, UsageError, withDb } from "./common";

export type RecapOptions = {
	today?: boolean;
	yesterday?: boolean;
	week?: boolean;
	date?: string;
	from?: string;
	to?: string;
	byDay?: boolean;
	/** false with --no-files. */
	files?: boolean;
	markdown?: boolean;
	json?: boolean;
	polish?: boolean;
	noIngest?: boolean;
	/** Test seam; default ingestPending(). */
	ingest?: (db: Db) => unknown;
	out?: Out;
	/** stderr, for the polish estimate. */
	err?: Out;
	now?: Date;
};

const RANGE_CONFLICT = "use one of --today, --yesterday, --date, --week, --from";

function rangeInput(o: RecapOptions): RangeInput {
	const named = (["today", "yesterday", "week"] as const).filter((k) => o[k]);
	if (named.length > 1) throw new UsageError(RANGE_CONFLICT);
	return { range: named[0], date: o.date, from: o.from, to: o.to };
}

export async function runRecap(o: RecapOptions = {}): Promise<void> {
	const out = o.out ?? stdout;
	if (o.markdown && o.json) throw new UsageError("use one of --markdown, --json");
	let range: ReturnType<typeof resolveRange>;
	try {
		range = resolveRange(rangeInput(o), o.now);
	} catch (e) {
		if (e instanceof RecapRangeError) throw new UsageError(e.message);
		throw e;
	}
	await withDb(async (db) => {
		if (!o.noIngest) (o.ingest ?? ingestPending)(db);
		const cfg = loadConfig();
		const recap = buildRecap(db, cfg, {
			range,
			groupBy: o.byDay ? "day" : "repo",
			files: o.files !== false,
			now: o.now,
		});
		const print = (r: Recap | PolishedRecap) =>
			out(o.json ? JSON.stringify(r, null, 2) : o.markdown ? formatMarkdown(r) : formatText(r));
		const empty = recap.sessions === 0;
		if (!o.polish || empty) return print(recap);
		const est = estimatePolishCost(db, recap, cfg);
		(o.err ?? stderr)(`polishing with one claude -p call (${est === null ? "cost unknown" : usd(est)})`);
		try {
			print(await polishRecap(db, recap, cfg));
		} catch (e) {
			if (!(e instanceof PolishError)) throw e;
			print(recap);
			throw e; // runCli prints "error: polish failed: <reason>" and exits 1
		}
	});
}

const usd = (v: number) => `~$${v < 0.01 && v > 0 ? v.toFixed(3) : v.toFixed(2)}`;
const stderr: Out = (line) => void process.stderr.write(`${line}\n`);

export function registerRecapCommand(program: Command): void {
	program
		.command("recap")
		.description("list what you worked on, grouped by repo, ready to paste (no AI unless --polish)")
		.option("--today", "today (the default)")
		.option("--yesterday", "yesterday")
		.option("--date <YYYY-MM-DD>", "one day")
		.option("--week", "today and the 6 days before it")
		.option("--from <YYYY-MM-DD>", "first day of a range")
		.option("--to <YYYY-MM-DD>", "last day of a range (default: today)")
		.option("--by-day", "one section per day")
		.option("--no-files", "leave out the file lines")
		.option("--markdown", "Markdown output")
		.option("--json", "JSON output")
		.option("--polish", "rewrite with one claude -p call (cost shown first)")
		.option("--no-ingest", "skip reading new transcript lines first")
		.action(async (opts: RecapOptions & { ingest?: boolean }) => {
			const { ingest, ...rest } = opts;
			await runRecap({ ...rest, noIngest: ingest === false });
		});
}

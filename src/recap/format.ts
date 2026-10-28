// Recap output formats (feature 17 "Output formats"): plain text and Markdown, "\n" line endings, no trailing blank
// line. By repo: the range header, then repo groups. By day: a header per day with work. A polished recap renders the
// same way without file lines. Day and month names are fixed English, never locale-dependent.
import type { PolishedRecap, Recap, RecapBullet, RecapGroup, RecapRange } from "./types";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function parts(date: string): { dow: string; md: string; year: string } {
	const [y, m, d] = date.split("-").map(Number);
	return { dow: DAYS[new Date(y, m - 1, d).getDay()], md: `${MONTHS[m - 1]} ${d}`, year: String(y) };
}

/** "Mon, Sep 28 2026", or "Tue, Sep 22 – Mon, Sep 28 2026" (both years when they differ). */
export function rangeLabel(r: RecapRange): string {
	const a = parts(r.from);
	if (r.from === r.to) return `${a.dow}, ${a.md} ${a.year}`;
	const b = parts(r.to);
	const left = a.year === b.year ? `${a.dow}, ${a.md}` : `${a.dow}, ${a.md} ${a.year}`;
	return `${left} – ${b.dow}, ${b.md} ${b.year}`;
}

type Item = { text: string; files: string[]; moreFiles: number };
type Section = { header: string; groups: { repo: string; items: Item[] }[] };

const fromGroup = (g: RecapGroup) => ({
	repo: g.repo,
	items: g.bullets.map((b: RecapBullet) => ({ text: b.text, files: b.files, moreFiles: b.moreFiles })),
});

function isPolished(r: Recap | PolishedRecap): r is PolishedRecap {
	return !("groupBy" in r);
}

function sections(r: Recap | PolishedRecap): Section[] {
	if (isPolished(r))
		return [
			{
				header: rangeLabel(r.range),
				groups: r.groups.map((g) => ({
					repo: g.repo,
					items: g.items.map((text) => ({ text, files: [], moreFiles: 0 })),
				})),
			},
		];
	if (r.groupBy === "day")
		return r.days.map((d) => ({ header: rangeLabel({ from: d.date, to: d.date }), groups: d.groups.map(fromGroup) }));
	return r.groups.length ? [{ header: rangeLabel(r.range), groups: r.groups.map(fromGroup) }] : [];
}

function emptyLine(r: Recap | PolishedRecap): string {
	const old = !isPolished(r) && r.retentionCutoff !== null && r.range.from < r.retentionCutoff;
	const note = old ? ` (older than the ${(r as Recap).retentionDays}-day retention window)` : "";
	return `No work recorded for ${rangeLabel(r.range)}${note}.`;
}

const more = (i: Item) => (i.moreFiles > 0 ? ` +${i.moreFiles}` : "");

function textOf(list: Section[]): string {
	return list
		.map((s) => {
			const groups = s.groups.map((g) =>
				[
					g.repo,
					...g.items.flatMap((i) => [
						`  • ${i.text}`,
						...(i.files.length ? [`    ${i.files.join(", ")}${more(i)}`] : []),
					]),
				].join("\n"),
			);
			return [s.header, ...groups].join("\n\n");
		})
		.join("\n\n");
}

const escapeMd = (s: string) => s.replace(/[\\`*_]/g, (c) => `\\${c}`);

function markdownOf(list: Section[]): string {
	return list
		.map((s) => {
			const groups = s.groups.map((g) =>
				[
					`### ${g.repo}`,
					"",
					...g.items.flatMap((i) => [
						`- ${escapeMd(i.text)}`,
						...(i.files.length ? [`  - ${i.files.map((f) => `\`${f}\``).join(", ")}${more(i)}`] : []),
					]),
				].join("\n"),
			);
			return [`## ${s.header}`, ...groups].join("\n\n");
		})
		.join("\n\n");
}

export function formatText(r: Recap | PolishedRecap): string {
	const list = sections(r);
	return list.length ? textOf(list) : emptyLine(r);
}

export function formatMarkdown(r: Recap | PolishedRecap): string {
	const list = sections(r);
	return list.length ? markdownOf(list) : emptyLine(r);
}

/** One repo's part of the recap, for per-repo copy: under the range header, or under each day it appears; "" if absent. */
export function formatRepo(r: Recap, repo: string, format: "text" | "markdown"): string {
	const list = sections(r)
		.map((s) => ({ header: s.header, groups: s.groups.filter((g) => g.repo === repo) }))
		.filter((s) => s.groups.length > 0);
	if (!list.length) return "";
	return format === "text" ? textOf(list) : markdownOf(list);
}

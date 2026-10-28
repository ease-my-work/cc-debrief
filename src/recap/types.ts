// Work recap types (feature 17 "Interfaces"); re-exported from server/types.ts for the UI.

/** Local calendar dates YYYY-MM-DD, inclusive. */
export type RecapRange = { from: string; to: string };
export type BulletSource = "title" | "summary" | "agent_name" | "files" | "explored";
export type RecapBullet = {
	text: string;
	source: BulletSource;
	/** Base names, most-changed first, at most 3; empty for source files / explored or with files off. */
	files: string[];
	moreFiles: number;
	sessionIds: string[];
	firstTurnAt: string;
};
export type RecapGroup = { repo: string; repoId: string | null; turns: number; bullets: RecapBullet[] };
export type RecapDay = { date: string; groups: RecapGroup[] };
export type Recap = {
	range: RecapRange;
	groupBy: "repo" | "day";
	/** Used when groupBy = "repo"; empty otherwise. */
	groups: RecapGroup[];
	/** Used when groupBy = "day"; empty otherwise. */
	days: RecapDay[];
	hiddenRepos: number;
	sessions: number;
	/** Local date before which retention purged the data; null when retention.days = 0. */
	retentionCutoff: string | null;
	/** retention.days, for the empty line "(older than the <n>-day retention window)". */
	retentionDays: number;
	/** Turns per local quarter hour (96 slots), per day with work, oldest first; hidden repos left out. View only. */
	activity: RecapActivity[];
};
export type RecapActivity = { date: string; slots: number[] };
export type PolishedRecap = {
	range: RecapRange;
	groups: { repo: string; items: string[] }[];
	costUsd: number | null;
	model?: string;
};
export type RangeInput = { range?: "today" | "yesterday" | "week"; date?: string; from?: string; to?: string };

// The dashboard ranges (feature 12; Phase 7 P1 adds 90d and all), in display order, with their two label styles.
import type { Range } from "@api-types";

export const RANGES: Range[] = ["today", "7d", "30d", "90d", "all"];

/** Segmented-control labels (Overview, Activity, Costs). */
export const SHORT_LABEL: Record<Range, string> = {
	today: "Today",
	"7d": "7 days",
	"30d": "30 days",
	"90d": "90 days",
	all: "All",
};

/** Dropdown labels (RangeSelect). */
export const LONG_LABEL: Record<Range, string> = {
	today: "Today",
	"7d": "Last 7 days",
	"30d": "Last 30 days",
	"90d": "Last 90 days",
	all: "All retained",
};

/** Lower-case phrase after a count ("12 sessions · 7 days"). */
export const PHRASE: Record<Range, string> = {
	today: "today",
	"7d": "7 days",
	"30d": "30 days",
	"90d": "90 days",
	all: "all retained",
};

export const SEGMENT_OPTIONS = RANGES.map((value) => ({ value, label: SHORT_LABEL[value] }));

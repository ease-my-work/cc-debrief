// Dashboard design tokens (feature 12 "Layout and design tokens") as data: styles.css defines the same values as
// CSS variables (a test keeps them in step), and the contrast test checks every text pair against WCAG AA.

export type Palette = {
	background: string;
	panel: string;
	border: string;
	ink: string;
	muted: string;
	accent: string;
	warm: string;
	good: string;
	bad: string;
	amber: string;
	amberFill: string;
	goodFill: string;
	badFill: string;
	accentFill: string;
	neutralFill: string;
	neutralText: string;
	seriesInput: string;
	seriesCacheRead: string;
	seriesOutput: string;
};

export const LIGHT: Palette = {
	background: "#F4F3EE",
	panel: "#FFFFFF",
	border: "#E3E1D9",
	ink: "#1C1B18",
	muted: "#6B685F",
	accent: "#3453C4",
	warm: "#C9772E",
	good: "#236B49",
	bad: "#9B3A24",
	amber: "#7A5410",
	amberFill: "#FBF1DC",
	goodFill: "#EAF4EE",
	badFill: "#FCEBE7",
	accentFill: "#E7EEFF",
	neutralFill: "#F1EEE6",
	neutralText: "#5E5A4F",
	seriesInput: "#3453C4",
	seriesCacheRead: "#9FB3F0",
	seriesOutput: "#D9A441",
};

// Dark values from feature 12 (marked "to be confirmed in the Settings comp"); fills and series are this phase's
// choices, keeping hue with lower lightness for fills and raised lightness for series.
export const DARK: Palette = {
	background: "#161512",
	panel: "#1F1E1B",
	border: "#34322C",
	ink: "#ECEAE3",
	muted: "#A19D92",
	accent: "#7F96F0",
	warm: "#E0924D",
	good: "#5DB38A",
	bad: "#E07A62",
	amber: "#E5B866",
	amberFill: "#3A2F18",
	goodFill: "#17301F",
	badFill: "#3A1F19",
	accentFill: "#1E2A4D",
	neutralFill: "#2B2924",
	neutralText: "#C9C4B8",
	seriesInput: "#7F96F0",
	seriesCacheRead: "#4A5C9E",
	seriesOutput: "#E5B866",
};

type Pair = { fill: string; text: string };
const badge = (light: Pair, dark: Pair) => ({ light, dark });

/** Session type badges (feature 12): docs and other use the exploration style. */
export const BADGES = {
	feature: badge({ fill: "#E7EEFF", text: "#26409A" }, { fill: "#1E2A4D", text: "#A9BCFF" }),
	bugfix: badge({ fill: "#FCEBE7", text: "#9B3A24" }, { fill: "#3A1F19", text: "#F0A08C" }),
	refactor: badge({ fill: "#EAF4EE", text: "#236B49" }, { fill: "#17301F", text: "#8FD3AE" }),
	exploration: badge({ fill: "#F1EEE6", text: "#5E5A4F" }, { fill: "#2B2924", text: "#C9C4B8" }),
	ops: badge({ fill: "#FBF1DC", text: "#7A5410" }, { fill: "#3A2F18", text: "#E5B866" }),
} as const;

function luminance(hex: string): number {
	const n = Number.parseInt(hex.slice(1), 16);
	const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
		const s = c / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2 contrast ratio of two #RRGGBB colours. */
export function contrast(a: string, b: string): number {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
}

/** Every text-on-background pair the UI draws, as [name, text, background]. */
export function TEXT_PAIRS(theme: "light" | "dark"): [string, string, string][] {
	const p = theme === "light" ? LIGHT : DARK;
	const pairs: [string, string, string][] = [];
	for (const surface of ["background", "panel"] as const) {
		for (const text of ["ink", "muted", "accent", "good", "bad"] as const) {
			pairs.push([`${text} on ${surface}`, p[text], p[surface]]);
		}
	}
	pairs.push(["amber on amberFill", p.amber, p.amberFill]);
	pairs.push(["good on goodFill", p.good, p.goodFill]);
	pairs.push(["bad on badFill", p.bad, p.badFill]);
	pairs.push(["accent on accentFill", p.accent, p.accentFill]);
	pairs.push(["neutralText on neutralFill", p.neutralText, p.neutralFill]);
	pairs.push(["panel on ink (dark pill)", p.panel, p.ink]);
	for (const [name, b] of Object.entries(BADGES)) pairs.push([`${name} badge`, b[theme].text, b[theme].fill]);
	return pairs;
}

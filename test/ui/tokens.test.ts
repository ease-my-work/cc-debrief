import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { BADGES, contrast, DARK, LIGHT, TEXT_PAIRS } from "../../ui/src/lib/tokens";

describe("theme tokens", () => {
	it("are exactly feature 12's light and dark palettes", () => {
		expect(LIGHT).toMatchObject({
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
			seriesInput: "#3453C4",
			seriesCacheRead: "#9FB3F0",
			seriesOutput: "#D9A441",
		});
		expect(DARK).toMatchObject({
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
		});
		expect(BADGES.feature.light).toEqual({ fill: "#E7EEFF", text: "#26409A" });
		expect(BADGES.bugfix.light).toEqual({ fill: "#FCEBE7", text: "#9B3A24" });
		expect(BADGES.refactor.light).toEqual({ fill: "#EAF4EE", text: "#236B49" });
		expect(BADGES.exploration.light).toEqual({ fill: "#F1EEE6", text: "#5E5A4F" });
		expect(BADGES.ops.light).toEqual({ fill: "#FBF1DC", text: "#7A5410" });
	});

	it("computes WCAG contrast", () => {
		expect(contrast("#000000", "#FFFFFF")).toBeCloseTo(21, 0);
		expect(contrast("#FFFFFF", "#FFFFFF")).toBeCloseTo(1, 5);
	});

	it.each(["light", "dark"] as const)("gives every text pair at least 4.5:1 in %s", (theme) => {
		const failing = TEXT_PAIRS(theme)
			.map(([name, fg, bg]) => [name, contrast(fg, bg)] as const)
			.filter(([, ratio]) => ratio < 4.5)
			.map(([name, ratio]) => `${name} ${ratio.toFixed(2)}`);
		expect(failing).toEqual([]);
	});

	it("are the values styles.css defines for both themes", () => {
		// The CSS formatter writes hex colours in lower case.
		const css = readFileSync(resolve(import.meta.dirname, "../../ui/src/styles.css"), "utf8").toLowerCase();
		const dark = css.slice(css.indexOf("prefers-color-scheme: dark"));
		const kebab = (k: string) => k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
		for (const [k, v] of Object.entries(LIGHT)) expect(css, k).toContain(`--color-${kebab(k)}: ${v.toLowerCase()};`);
		for (const [k, v] of Object.entries(DARK)) expect(dark, k).toContain(`--color-${kebab(k)}: ${v.toLowerCase()};`);
	});
});

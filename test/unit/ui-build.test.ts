// The built UI (dist/ui) loads nothing from outside the dashboard origin: no remote URLs, fonts as local files.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ui = resolve(import.meta.dirname, "../../dist/ui");
// Skipped when the UI is not built; CI sets REQUIRE_DIST=1 so a missing build fails instead.
const suite = process.env.REQUIRE_DIST === "1" || existsSync(join(ui, "index.html")) ? describe : describe.skip;

const files = (dir: string): string[] =>
	readdirSync(dir).flatMap((n) => {
		const p = join(dir, n);
		return statSync(p).isDirectory() ? files(p) : [p];
	});

// XML namespaces are identifiers, not requests; library error text links to documentation pages the code never
// fetches (it builds a message string for a developer).
// Recharts bundles Redux, Redux Toolkit and Immer, whose minified errors do the same.
const ALLOWED = [
	/^http:\/\/www\.w3\.org\//,
	/^https:\/\/react\.dev\/errors\//,
	/^https:\/\/reactjs\.org\/docs\/error-decoder/,
	/^https:\/\/redux\.js\.org\/Errors\?code=/,
	/^https:\/\/redux-toolkit\.js\.org\/Errors\?code=/,
	/^https:\/\/bit\.ly\/3cXEKWf$/, // Immer: "Full error at: …"
	/^https:\/\/github\.com\/syntax-tree\/hast-util-to-jsx-runtime/, // react-markdown (Phase 7): a docs link in an error message
];

suite("built UI", () => {
	it("has index.html and its assets", () => {
		expect(existsSync(join(ui, "index.html"))).toBe(true);
		expect(files(ui).some((f) => f.endsWith(".js"))).toBe(true);
	});

	it("contains no http(s) URL outside the allowlist", () => {
		const found: string[] = [];
		for (const f of files(ui)) {
			if (!/\.(html|js|css|svg|json)$/.test(f)) continue;
			// CSS comments (the Tailwind licence banner) cannot make a request.
			const raw = readFileSync(f, "utf8");
			const text = f.endsWith(".css") ? raw.replace(/\/\*[\s\S]*?\*\//g, "") : raw;
			for (const m of text.matchAll(/https?:\/\/[^\s"'`)<>\\]+/g)) {
				if (!ALLOWED.some((a) => a.test(m[0]))) found.push(`${f.slice(ui.length + 1)}: ${m[0]}`);
			}
		}
		expect(found).toEqual([]);
	});

	it("bundles the IBM Plex fonts as local files", () => {
		const fonts = files(ui).filter((f) => f.endsWith(".woff2"));
		expect(fonts.some((f) => /ibm-plex-sans/i.test(f))).toBe(true);
		expect(fonts.some((f) => /ibm-plex-mono/i.test(f))).toBe(true);
		const css = files(ui)
			.filter((f) => f.endsWith(".css"))
			.map((f) => readFileSync(f, "utf8"))
			.join("\n");
		expect(css).not.toMatch(/fonts\.googleapis|@import\s+url\(\s*["']?https?:/);
	});
});

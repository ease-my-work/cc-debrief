import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const here = import.meta.dirname;

// The dashboard UI, prebuilt into dist/ui and served by `cc-debrief dashboard` (feature 12). Everything it loads is
// bundled here: no CDN, no remote fonts.
export default defineConfig({
	root: here,
	base: "/",
	plugins: [react(), tailwindcss()],
	// @redact: the Settings Test box runs the same pattern rules as capture (src/redact.ts has no imports).
	// @rule-labels: coaching rule labels (src/coach/labels.ts has no imports).
	resolve: {
		alias: {
			"@api-types": resolve(here, "../src/server/types.ts"),
			"@redact": resolve(here, "../src/redact.ts"),
			"@rule-labels": resolve(here, "../src/coach/labels.ts"),
		},
	},
	build: {
		outDir: resolve(here, "../dist/ui"),
		emptyOutDir: true,
		assetsInlineLimit: 0, // fonts stay files, never data: URIs
	},
});

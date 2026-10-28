import { defineConfig } from "tsup";

export default defineConfig({
	entry: { cli: "src/cli.ts", hook: "src/hook.ts" },
	format: "esm",
	platform: "node",
	target: "node22",
	// Self-contained bundles: the published package has no runtime dependencies.
	noExternal: [/.*/],
	splitting: false,
	clean: true,
	loader: { ".sql": "text" },
	// Bundled CommonJS dependencies call require(); ESM output has none, so define it.
	banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
});

import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildSync } from "esbuild";

const root = resolve(import.meta.dirname, "../..");

/**
 * Bundles a snippet of TypeScript (imports relative to the repo root) into one ESM file in dir, the way tsup
 * builds dist/, so a child process can run real src/ code. Returns the file path.
 */
export function bundleScript(dir: string, code: string, name = "child.mjs"): string {
	const out = buildSync({
		stdin: { contents: code, resolveDir: root, loader: "ts", sourcefile: "child.ts" },
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node22",
		loader: { ".sql": "text" },
		// As tsup does for dist/: ESM entries of dual packages, and require() for bundled CommonJS dependencies.
		mainFields: ["module", "main"],
		banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
		write: false,
		logLevel: "silent",
	});
	const file = join(dir, name);
	writeFileSync(file, out.outputFiles[0].text);
	return file;
}

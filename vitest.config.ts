import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

// Perf tests (test/perf: timing budgets) run only via `npm run test:perf` (mode "perf") or with PERF=1, one file at a
// time.
// Two projects: node (everything outside test/ui) and ui (React components under jsdom).
export default defineConfig(({ mode }) => {
	const perf = mode === "perf" || process.env.PERF === "1";
	return {
		// Load .sql as text, like tsup's loader.
		plugins: [
			{
				name: "sql-text",
				transform: (code: string, id: string) =>
					id.endsWith(".sql") ? { code: `export default ${JSON.stringify(code)};`, map: null } : undefined,
			},
		],
		resolve: {
			alias: {
				"@api-types": resolve(import.meta.dirname, "src/server/types.ts"),
				"@redact": resolve(import.meta.dirname, "src/redact.ts"),
				"@rule-labels": resolve(import.meta.dirname, "src/coach/labels.ts"),
			},
		},
		test: {
			testTimeout: 20000,
			// Timing budgets are measured one file at a time, so one perf file's disk and CPU load never skews another's.
			fileParallelism: !perf,
			projects: [
				{
					extends: true,
					test: {
						name: "node",
						include: ["test/**/*.test.{ts,mjs}"],
						exclude: perf ? ["**/node_modules/**", "test/ui/**"] : ["**/node_modules/**", "test/perf/**", "test/ui/**"],
						// Sandboxes the home dir per file and fails a file that writes to ~/.cc-debrief or ~/.claude.
						setupFiles: ["test/helpers/guard-home.ts"],
					},
				},
				{
					extends: true,
					test: {
						name: "ui",
						include: ["test/ui/**/*.test.{ts,tsx}"],
						environment: "jsdom",
						setupFiles: ["test/ui/setup.ts"],
					},
				},
			],
		},
	};
});

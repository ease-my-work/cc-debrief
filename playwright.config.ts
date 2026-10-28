import { defineConfig, devices } from "@playwright/test";

// One UI smoke test (Phase 2), run in Linux CI after `npm run build`. Locally, PW_CHANNEL=chrome uses an installed
// Chrome instead of downloading Playwright's browsers.
export default defineConfig({
	testDir: "test/e2e",
	testMatch: "*.spec.ts",
	timeout: 60_000,
	workers: 1,
	reporter: "list",
	use: { trace: "retain-on-failure" },
	projects: [
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"], ...(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {}) },
		},
	],
});

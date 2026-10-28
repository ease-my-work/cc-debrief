// The published tarball (Phase 3 spec "Publish"): only dist/**, README.md, LICENSE and package.json, no runtime
// dependencies, no source maps, under 5 MB. Needs a build; CI sets REQUIRE_DIST=1 so a missing build fails.
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const built = existsSync(resolve(root, "dist/cli.js")) && existsSync(resolve(root, "dist/ui/index.html"));
const suite = process.env.REQUIRE_DIST === "1" || built ? describe : describe.skip;

type PackResult = { size: number; files: { path: string; size: number }[] };

suite("npm pack", () => {
	let pack: PackResult;
	beforeAll(() => {
		const out = execSync("npm pack --dry-run --json --ignore-scripts", { cwd: root, encoding: "utf8" });
		pack = (JSON.parse(out) as PackResult[])[0];
	}, 60_000);

	it("holds only dist/**, README.md, LICENSE and package.json", () => {
		const paths = pack.files.map((f) => f.path.replaceAll("\\", "/"));
		const top = new Set(paths.map((p) => (p.includes("/") ? `${p.split("/")[0]}/` : p)));
		expect([...top].sort()).toEqual(["LICENSE", "README.md", "dist/", "package.json"]);
		expect(paths).toContain("dist/cli.js");
		expect(paths).toContain("dist/hook.js");
		expect(paths).toContain("dist/ui/index.html");
		for (const p of paths) {
			expect(p, p).not.toMatch(/^(test|docs|scripts|spike|src|ui\/src|\.changeset|\.github)\//);
			expect(p, p).not.toMatch(/\.map$/);
		}
	});

	it("is under 5 MB", () => {
		expect(pack.size).toBeLessThan(5 * 1024 * 1024);
	});
});

describe("package.json for publishing", () => {
	const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

	it("has no runtime dependencies and is publishable", () => {
		expect(pkg.dependencies).toBeUndefined();
		expect(pkg.private).toBeUndefined();
		expect(pkg.name).toBe("cc-debrief");
		expect(pkg.license).toBe("MIT");
		expect(pkg.files).toEqual(["dist"]);
		expect(pkg.bin).toEqual({ "cc-debrief": "dist/cli.js" });
		expect(pkg.engines).toEqual({ node: ">=22.13" });
	});

	it("names the repository, bugs, homepage and keywords", () => {
		expect(pkg.repository).toEqual({ type: "git", url: "git+https://github.com/ease-my-work/cc-debrief.git" });
		expect(pkg.bugs).toEqual({ url: "https://github.com/ease-my-work/cc-debrief/issues" });
		expect(pkg.homepage).toBe("https://github.com/ease-my-work/cc-debrief#readme");
		expect(pkg.keywords).toEqual(expect.arrayContaining(["claude-code", "claude", "cli", "dashboard"]));
		expect(pkg.scripts.prepublishOnly).toBe("npm run build && npm test");
	});

	it("ships a LICENSE and README", () => {
		expect(readFileSync(resolve(root, "LICENSE"), "utf8")).toMatch(/^MIT License/);
		expect(readFileSync(resolve(root, "README.md"), "utf8")).toMatch(/npx cc-debrief init/);
	});
});

#!/usr/bin/env node
// Installs the packed tarball into a temp npm prefix and runs it like a user would, against temp homes and a fake
// `claude` (no real Claude Code is ever called): --version, init --no-backfill, doctor, uninit. Used by the CI
// `pack` job on Windows, macOS and Linux. Usage: node scripts/pack-smoke.mjs [path/to/cc-debrief-x.y.z.tgz]
import { execFileSync, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

const win = process.platform === "win32";
const root = resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const work = mkdtempSync(join(tmpdir(), "ccd-pack-"));

function step(name, fn) {
	process.stdout.write(`- ${name}\n`);
	return fn();
}

function run(cmd, args, opts = {}) {
	const r = spawnSync(cmd, args, { encoding: "utf8", shell: win, ...opts });
	if (r.status !== 0) {
		process.stdout.write(r.stdout ?? "");
		process.stderr.write(r.stderr ?? "");
		throw new Error(`${cmd} ${args.join(" ")} exited ${r.status}`);
	}
	return r.stdout;
}

try {
	const tarball =
		process.argv[2] ??
		step("npm pack", () => {
			const out = execFileSync(win ? "npm.cmd" : "npm", ["pack", "--json", "--pack-destination", work], {
				cwd: root,
				encoding: "utf8",
				shell: win,
			});
			return join(work, JSON.parse(out)[0].filename);
		});

	const prefix = join(work, "prefix");
	step("install the tarball into a temp prefix", () =>
		run("npm", ["install", "--global", "--prefix", prefix, tarball]),
	);
	const binDir = win ? prefix : join(prefix, "bin");
	const exe = join(binDir, win ? "cc-debrief.cmd" : "cc-debrief");
	if (!existsSync(exe)) throw new Error(`no cc-debrief in ${binDir}: ${readdirSync(binDir).join(", ")}`);

	// A claude stand-in that answers --version, first on PATH; doctor needs one while summaries are on.
	const fake = join(work, "fake-bin");
	mkdirSync(fake, { recursive: true });
	writeFileSync(join(fake, "claude.mjs"), 'process.stdout.write("2.4.1 (Claude Code)\\n");\n');
	writeFileSync(join(fake, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${join(fake, "claude.mjs")}" "$@"\n`);
	chmodSync(join(fake, "claude"), 0o755);
	writeFileSync(join(fake, "claude.cmd"), `@"${process.execPath}" "${join(fake, "claude.mjs")}" %*\r\n`);

	const home = join(work, "home");
	const claude = join(work, "claude");
	mkdirSync(join(claude, "projects"), { recursive: true });
	const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
	const env = {
		...process.env,
		CC_DEBRIEF_HOME: home,
		CLAUDE_CONFIG_DIR: claude,
		CC_DEBRIEF_DB: join(home, "tracker.db"),
	};
	delete env[pathKey];
	env.PATH = `${fake}${delimiter}${binDir}${delimiter}${process.env[pathKey] ?? ""}`;
	const cli = (...args) => run(exe, args, { env });

	step("cc-debrief --version", () => {
		const v = cli("--version").trim();
		if (v !== pkg.version) throw new Error(`--version printed ${v}, package.json has ${pkg.version}`);
	});
	step("cc-debrief init --no-backfill", () => {
		const out = cli("init", "--no-backfill");
		if (!/added +4 hooks/.test(out)) throw new Error(`init did not add 4 hooks:\n${out}`);
		const settings = JSON.parse(readFileSync(join(claude, "settings.json"), "utf8"));
		if (Object.keys(settings.hooks ?? {}).length !== 4) throw new Error("settings.json does not hold 4 hook events");
	});
	step("cc-debrief doctor", () => process.stdout.write(cli("doctor")));
	step("cc-debrief uninit", () => {
		cli("uninit");
		// init created settings.json here, so uninit removes it again; any file left must hold no tracker hook.
		const path = join(claude, "settings.json");
		if (existsSync(path) && readFileSync(path, "utf8").includes("# cc-debrief")) {
			throw new Error("uninit left a tracker hook in settings.json");
		}
	});
	process.stdout.write("pack smoke test passed\n");
} finally {
	rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

import { cpSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { StoredLine } from "../../src/collector/transcript";
import { lineColumns, parseLine, slimLine } from "../../src/ingest/line";

export const FIXTURES = resolve(import.meta.dirname, "../fixtures");

/**
 * Writes a main transcript (<claudeDir>/projects/<project>/<sessionId>.jsonl) or, with opts.agentId, a subagent
 * transcript (<sessionId>/subagents/agent-<agentId>.jsonl, plus .meta.json when opts.meta is given). Returns its path.
 */
export function writeTranscript(
	claudeDir: string,
	project: string,
	sessionId: string,
	lines: object[],
	opts: { agentId?: string; meta?: object } = {},
): string {
	const dir = join(claudeDir, "projects", project);
	const path = opts.agentId
		? join(dir, sessionId, "subagents", `agent-${opts.agentId}.jsonl`)
		: join(dir, `${sessionId}.jsonl`);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
	if (opts.agentId && opts.meta) writeFileSync(path.replace(/\.jsonl$/, ".meta.json"), JSON.stringify(opts.meta));
	return path;
}

function walk(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) walk(p, out);
		else out.push(p);
	}
	return out;
}

/** Every JSONL file under test/fixtures/transcripts (Phase 0) and test/fixtures/synthetic. */
export function fixtureJsonlFiles(): string[] {
	return [...walk(join(FIXTURES, "transcripts")), ...walk(join(FIXTURES, "synthetic"))].filter((f) =>
		f.endsWith(".jsonl"),
	);
}

/** Every non-empty raw line of every fixture JSONL file, with a short label for test names. */
export function fixtureLines(): { label: string; raw: string }[] {
	return fixtureJsonlFiles().flatMap((f) =>
		readFileSync(f, "utf8")
			.split("\n")
			.map((raw, i) => ({ label: `${relative(FIXTURES, f)}:${i + 1}`, raw }))
			.filter((l) => l.raw.trim() !== ""),
	);
}

/** A Phase 0 or synthetic case directory's transcripts as derive would load them: main file first, slimmed. */
export function storedLines(caseDir: string): StoredLine[] {
	const files = walk(caseDir)
		.filter((f) => f.endsWith(".jsonl"))
		.map((f) => ({ path: f, agentId: /agent-([^/]+)\.jsonl$/.exec(f)?.[1] ?? null }))
		.sort((a, b) => Number(a.agentId !== null) - Number(b.agentId !== null) || (a.path < b.path ? -1 : 1));
	return files.flatMap(({ path, agentId }) =>
		readFileSync(path, "utf8")
			.split("\n")
			.filter((raw) => raw.trim() !== "")
			.flatMap((raw, lineNo) => {
				const parsed = parseLine(raw);
				if (!parsed.ok) return [];
				const cols = lineColumns(parsed.line);
				const payload = slimLine(parsed.line);
				return payload
					? [{ lineNo, agentId, uuid: cols.uuid, type: cols.type, subtype: cols.subtype, ts: cols.ts, payload }]
					: [];
			}),
	);
}

/** Phase 0 cases: every directory under test/fixtures/transcripts/<surface>/ holding a case.json. */
export function phase0Cases(): { dir: string; caseJson: { surface: string; covers: string[]; sessionId: string } }[] {
	const root = join(FIXTURES, "transcripts");
	return readdirSync(root).flatMap((surface) =>
		readdirSync(join(root, surface)).map((name) => {
			const dir = join(root, surface, name);
			return { dir, caseJson: JSON.parse(readFileSync(join(dir, "case.json"), "utf8")) };
		}),
	);
}

export const readExpected = (name: string) =>
	JSON.parse(readFileSync(join(FIXTURES, "synthetic", `${name}.expected.json`), "utf8"));

/** Every Phase 0 hook payload: test/fixtures/hooks/<surface>/<Event>[-variant].json. */
export function hookFixtures(): {
	surface: string;
	name: string;
	path: string;
	raw: string;
	payload: Record<string, unknown>;
}[] {
	const root = join(FIXTURES, "hooks");
	return readdirSync(root).flatMap((surface) =>
		readdirSync(join(root, surface))
			.filter((f) => f.endsWith(".json"))
			.map((f) => {
				const path = join(root, surface, f);
				const raw = readFileSync(path, "utf8");
				return { surface, name: f.slice(0, -5), path, raw, payload: JSON.parse(raw) };
			}),
	);
}

export type CaseJson = { surface: string; covers: string[]; sessionId: string; case: string };

/** Every Phase 0 case with its surface, directory, session id and case.json. */
export function loadFixtureCases(): { surface: string; caseDir: string; sessionId: string; caseJson: CaseJson }[] {
	return phase0Cases().map(({ dir, caseJson }) => ({
		surface: caseJson.surface,
		caseDir: dir,
		sessionId: caseJson.sessionId,
		caseJson: caseJson as CaseJson,
	}));
}

/** Copies a case directory's transcripts into <claudeDir>/projects/<case name>/, as Claude Code lays them out. */
export function copyFixtureInto(claudeDir: string, caseDir: string): string {
	const dest = join(claudeDir, "projects", `-fixture-${basename(caseDir)}`);
	cpSync(caseDir, dest, { recursive: true, filter: (src) => !src.endsWith("case.json") });
	return dest;
}

// Finds Claude Code transcripts under <claudeDir>/projects. Read-only; never throws on unreadable dirs.
import { type Dirent, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { projectsDir } from "../paths";

export type TranscriptFile = {
	path: string;
	sessionId: string;
	agentId: string | null; // null = main transcript
	size: number;
	mtimeMs: number;
};

export type SubagentMeta = { agentType?: string; description?: string; toolUseId?: string };

// Ids end up in lock file names and SQL rows; anything else is not a Claude Code transcript.
const ID = /^[A-Za-z0-9-]{1,100}$/;
const AGENT_FILE = /^agent-([A-Za-z0-9_-]{1,100})\.jsonl$/;

function entries(dir: string): Dirent[] {
	try {
		return readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
}

function withStat(path: string, sessionId: string, agentId: string | null): TranscriptFile | null {
	try {
		const st = statSync(path);
		return { path, sessionId, agentId, size: st.size, mtimeMs: st.mtimeMs };
	} catch {
		return null; // removed meanwhile
	}
}

/**
 * Main transcripts `projects/<project>/<sessionId>.jsonl` and subagent transcripts
 * `projects/<project>/<sessionId>/subagents/agent-<agentId>.jsonl`, sorted by path. `since` keeps files modified
 * at or after that time.
 */
export function listTranscripts(opts: { since?: Date } = {}): TranscriptFile[] {
	const out: TranscriptFile[] = [];
	const root = projectsDir();
	for (const project of entries(root)) {
		if (!project.isDirectory()) continue;
		const dir = join(root, project.name);
		for (const e of entries(dir)) {
			if (e.isFile() && e.name.endsWith(".jsonl")) {
				const sessionId = e.name.slice(0, -".jsonl".length);
				const f = ID.test(sessionId) ? withStat(join(dir, e.name), sessionId, null) : null;
				if (f) out.push(f);
			} else if (e.isDirectory() && ID.test(e.name)) {
				const subDir = join(dir, e.name, "subagents");
				for (const s of entries(subDir)) {
					const m = s.isFile() ? AGENT_FILE.exec(s.name) : null;
					const f = m ? withStat(join(subDir, s.name), e.name, m[1]) : null;
					if (f) out.push(f);
				}
			}
		}
	}
	const since = opts.since?.getTime();
	return out.filter((f) => since === undefined || f.mtimeMs >= since).sort((a, b) => (a.path < b.path ? -1 : 1));
}

/** The agent-<id>.meta.json beside a subagent transcript; null for a main transcript or a missing/invalid file. */
export function readSubagentMeta(file: TranscriptFile): SubagentMeta | null {
	if (file.agentId === null) return null;
	try {
		const raw: unknown = JSON.parse(readFileSync(file.path.replace(/\.jsonl$/, ".meta.json"), "utf8"));
		if (typeof raw !== "object" || raw === null) return null;
		const meta: SubagentMeta = {};
		for (const key of ["agentType", "description", "toolUseId"] as const) {
			const v = (raw as Record<string, unknown>)[key];
			if (typeof v === "string") meta[key] = v;
		}
		return meta;
	} catch {
		return null;
	}
}

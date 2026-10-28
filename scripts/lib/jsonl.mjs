import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

// Parses a JSONL file. A trailing partial line (no newline yet, being written) is skipped, not counted.
export function readJsonl(file) {
	const text = readFileSync(file, "utf8");
	const parts = text.split("\n");
	if (!text.endsWith("\n")) parts.pop();
	const lines = [];
	let parseErrors = 0;
	for (const part of parts) {
		if (!part.trim()) continue;
		try {
			lines.push(JSON.parse(part));
		} catch {
			parseErrors++;
		}
	}
	return { lines, parseErrors };
}

const dirs = (d) => {
	try {
		return readdirSync(d, { withFileTypes: true });
	} catch {
		return [];
	}
};

// Main transcripts `<project>/<session-id>.jsonl` and subagent transcripts `<project>/<uuid>/subagents/agent-*.jsonl`.
export function listSessionFiles(projectsDir) {
	const out = [];
	for (const project of dirs(projectsDir)) {
		if (!project.isDirectory()) continue;
		const pdir = join(projectsDir, project.name);
		for (const e of dirs(pdir)) {
			if (e.isFile() && e.name.endsWith(".jsonl")) {
				out.push({ path: join(pdir, e.name), sessionId: e.name.slice(0, -6), agentId: null, metaPath: null });
			} else if (e.isDirectory()) {
				const sub = join(pdir, e.name, "subagents");
				for (const s of dirs(sub)) {
					if (!s.isFile() || !/^agent-.+\.jsonl$/.test(s.name)) continue;
					const agentId = basename(s.name, ".jsonl").slice("agent-".length);
					const metaPath = join(sub, `agent-${agentId}.meta.json`);
					out.push({
						path: join(sub, s.name),
						sessionId: e.name,
						agentId,
						metaPath: existsSync(metaPath) ? metaPath : null,
					});
				}
			}
		}
	}
	return out;
}

// The main file for `sessionId` first, then its subagent files.
export function findSessionFiles(projectsDir, sessionId) {
	return listSessionFiles(projectsDir)
		.filter((f) => f.sessionId === sessionId)
		.sort((a, b) => (a.agentId === null ? -1 : b.agentId === null ? 1 : a.path.localeCompare(b.path)));
}

// Synthetic Claude Code transcripts for the perf suite: turns of user prompt → assistant tool_use / tool_result
// pairs → assistant text, with usage on every assistant line, attachments, and a share of large tool outputs.
// Deterministic for a given seed.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type GenOptions = {
	lines: number;
	/** tool_use / tool_result pairs (default lines / 40). */
	toolCalls?: number;
	/** Share of tool results that are large (default 0.05). */
	largeRatio?: number;
	/** Size of a large tool result in bytes (default 20 KB). */
	largeBytes?: number;
	seed?: number;
	/** First line number, for appending to an existing transcript (keeps uuids unique). */
	start?: number;
	startTime?: number;
};

const WORDS =
	"the a to of and in is for that with on this file test function return value error update change fix add remove config build run check type import export const let async await string number".split(
		" ",
	);

function rng(seed: number): () => number {
	let s = seed >>> 0 || 1;
	return () => {
		s ^= s << 13;
		s ^= s >>> 17;
		s ^= s << 5;
		return (s >>> 0) / 4294967296;
	};
}

/** Generates `opts.lines` transcript lines (objects) for one session. */
export function genLines(sessionId: string, opts: GenOptions): object[] {
	const rand = rng(opts.seed ?? 1);
	const words = (n: number) => Array.from({ length: n }, () => WORDS[Math.floor(rand() * WORDS.length)]).join(" ");
	const start = opts.start ?? 0;
	const t0 = opts.startTime ?? Date.parse("2026-09-29T09:00:00Z");
	const toolCalls = opts.toolCalls ?? Math.floor(opts.lines / 40);
	const toolEvery = toolCalls > 0 ? opts.lines / (toolCalls * 2) : Number.POSITIVE_INFINITY;
	const largeRatio = opts.largeRatio ?? 0.05;
	const largeBytes = opts.largeBytes ?? 20_000;
	const out: object[] = [];
	let n = start;
	let parent: string | null = start > 0 ? `${sessionId.slice(0, 8)}-${String(start - 1).padStart(8, "0")}` : null;
	let tools = 0;
	let nextTool = toolEvery;
	const base = () => {
		const uuid = `${sessionId.slice(0, 8)}-${String(n).padStart(8, "0")}`;
		const line = {
			uuid,
			parentUuid: parent,
			isSidechain: false,
			userType: "external",
			entrypoint: "cli",
			cwd: "/home/dev/project",
			sessionId,
			version: "2.1.284",
			gitBranch: "main",
			timestamp: new Date(t0 + n * 1500).toISOString(),
		};
		parent = uuid;
		n++;
		return line;
	};
	const usage = () => ({
		input_tokens: 5 + Math.floor(rand() * 50),
		output_tokens: 20 + Math.floor(rand() * 400),
		cache_read_input_tokens: 20_000 + Math.floor(rand() * 60_000),
		cache_creation_input_tokens: Math.floor(rand() * 3000),
		service_tier: "standard",
	});
	const assistant = (content: object[]) => ({
		...base(),
		type: "assistant",
		requestId: `req_${n}`,
		message: {
			id: `msg_${sessionId.slice(0, 8)}_${n}`,
			type: "message",
			role: "assistant",
			model: "claude-opus-5-5",
			content,
			stop_reason: null,
			usage: usage(),
		},
	});
	while (out.length < opts.lines) {
		if (out.length >= nextTool && tools < toolCalls && opts.lines - out.length >= 2) {
			const id = `toolu_${n}`;
			const kind = tools % 3;
			const input =
				kind === 0
					? { command: `npm test -- ${words(3)}`, description: words(5) }
					: kind === 1
						? { file_path: `/home/dev/project/src/${WORDS[tools % WORDS.length]}.ts` }
						: {
								file_path: `/home/dev/project/src/${WORDS[tools % WORDS.length]}.ts`,
								old_string: words(12),
								new_string: words(14),
							};
			const name = kind === 0 ? "Bash" : kind === 1 ? "Read" : "Edit";
			out.push(assistant([{ type: "tool_use", id, name, input }]));
			const large = rand() < largeRatio;
			const text = large ? words(Math.ceil(largeBytes / 5)).slice(0, largeBytes) : words(40 + Math.floor(rand() * 200));
			out.push({
				...base(),
				type: "user",
				message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text, is_error: false }] },
				toolUseResult:
					kind === 0
						? { stdout: text, stderr: "", interrupted: false, isImage: false }
						: kind === 1
							? { type: "text", file: { filePath: input.file_path, content: text, numLines: 40 } }
							: {
									filePath: input.file_path,
									oldString: input.old_string,
									newString: input.new_string,
									structuredPatch: [
										{
											oldStart: 3,
											oldLines: 1,
											newStart: 3,
											newLines: 1,
											lines: [`-${input.old_string}`, `+${input.new_string}`],
										},
									],
								},
			});
			tools++;
			nextTool += toolEvery;
			continue;
		}
		const r = rand();
		if (r < 0.1) {
			out.push({
				...base(),
				type: "user",
				promptId: `p${n}`,
				permissionMode: "default",
				message: { role: "user", content: `${words(15 + Math.floor(rand() * 40))}?` },
			});
		} else if (r < 0.2) {
			out.push({
				...base(),
				type: "attachment",
				attachment: { type: "hook_success", hookName: "Stop", hookEvent: "Stop", content: "", stdout: "", stderr: "" },
			});
		} else if (r < 0.3) {
			out.push(assistant([{ type: "thinking", thinking: words(60), signature: "s".repeat(400) }]));
		} else {
			out.push(assistant([{ type: "text", text: words(30 + Math.floor(rand() * 150)) }]));
		}
	}
	return out;
}

const jsonl = (lines: object[]) => lines.map((l) => `${JSON.stringify(l)}\n`).join("");

/** Writes a generated session to <claudeDir>/projects/<project>/<sessionId>.jsonl; returns the path. */
export function writeGenTranscript(claudeDir: string, project: string, sessionId: string, opts: GenOptions): string {
	const path = join(claudeDir, "projects", project, `${sessionId}.jsonl`);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, jsonl(genLines(sessionId, opts)));
	return path;
}

/** Appends generated lines numbered from opts.start. */
export function appendGenLines(path: string, sessionId: string, opts: GenOptions): void {
	appendFileSync(path, jsonl(genLines(sessionId, opts)));
}

/** A uuid-shaped session id for index i. */
export const genSessionId = (i: number) =>
	`${String(i).padStart(8, "0")}-0000-4000-8000-${String(i).padStart(12, "0")}`;

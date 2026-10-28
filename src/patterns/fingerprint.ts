// Tool-sequence fingerprints (feature 10 signal 2): a session's tool calls as steps `Tool:arg`, compared by the
// Jaccard of their consecutive-step trigrams. Pure JS.
import { commandKey } from "../coach/command-key";

export type Step = string; // "Bash:trivy", "Read:Dockerfile", "mcp:postgres", "Grep:"

const FILE_TOOLS = new Set(["Read", "Edit", "Write", "MultiEdit", "NotebookEdit"]);
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);
const MIN_STEPS = 3;

const basename = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

function stepOf(call: { tool_name: string; input: unknown; mcp_server: string | null }): Step {
	const input = (call.input ?? {}) as Record<string, unknown>;
	if (call.mcp_server) return `mcp:${call.mcp_server}`;
	if (SHELL_TOOLS.has(call.tool_name)) {
		return `${call.tool_name}:${typeof input.command === "string" ? commandKey(input.command) : ""}`;
	}
	if (FILE_TOOLS.has(call.tool_name)) {
		const p = input.file_path ?? input.notebook_path ?? input.path;
		return `${call.tool_name}:${typeof p === "string" ? basename(p) : ""}`;
	}
	return `${call.tool_name}:`;
}

/**
 * The calls (in started_at order) as steps: the shell command key for Bash / PowerShell (feature 07 commandKey), the
 * file basename for file tools, `mcp:<server>` for MCP tools, empty otherwise. Consecutive identical steps collapse.
 */
export function toolSkeleton(calls: { tool_name: string; input: unknown; mcp_server: string | null }[]): Step[] {
	const out: Step[] = [];
	for (const c of calls) {
		const s = stepOf(c);
		if (out.at(-1) !== s) out.push(s);
	}
	return out;
}

/** Whether the skeleton has enough distinct steps to be fingerprinted (feature 10: three). */
export const fingerprintable = (steps: Step[]): boolean => new Set(steps).size >= MIN_STEPS;

/** The set of consecutive-step trigrams. */
export function trigrams(steps: Step[]): Set<string> {
	const out = new Set<string>();
	for (let i = 0; i + 2 < steps.length; i++) out.add(`${steps[i]}\u0001${steps[i + 1]}\u0001${steps[i + 2]}`);
	return out;
}

/** Jaccard of two trigram sets (precomputed once per detection run). */
export function setJaccard(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 || b.size === 0) return 0;
	const [small, large] = a.size <= b.size ? [a, b] : [b, a];
	let shared = 0;
	for (const t of small) if (large.has(t)) shared++;
	return shared / (a.size + b.size - shared);
}

/** Trigram Jaccard of two skeletons, 0..1; 0 when either has fewer than 3 distinct steps. */
export function trigramJaccard(a: Step[], b: Step[]): number {
	if (!fingerprintable(a) || !fingerprintable(b)) return 0;
	return setJaccard(trigrams(a), trigrams(b));
}

/** The display form: "Bash:trivy → Read:Dockerfile → Edit:Dockerfile". */
export const fingerprintText = (steps: Step[]): string => steps.join(" → ");

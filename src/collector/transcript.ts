// Pure readers over a session's stored transcript lines (used by derive/session.ts).

export type StoredLine = {
	/** transcript_lines.id when loaded from the DB (derive's append path keys on it). */
	id?: number;
	lineNo: number;
	agentId: string | null; // null = main transcript
	uuid: string | null;
	type: string;
	subtype: string | null;
	ts: string | null;
	payload: Record<string, unknown>;
};

export type UsageRow = {
	model: string;
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	/** Part of cacheCreationTokens written to the 1-hour cache (priced at 2x input). */
	cacheCreation1hTokens: number;
	cacheReadTokens: number;
	ts: string;
	messageId: string;
	requestId: string | null;
	agentId: string | null;
};

export type UsageTotals = {
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
};

export type CostState = {
	totalCostUsd: number;
	models: Record<
		string,
		{
			inputTokens: number;
			outputTokens: number;
			thinkingTokens: number;
			cacheReadTokens: number;
			cacheCreationTokens: number;
			costUsd: number;
		}
	>;
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const SYNTHETIC = "<synthetic>";

/**
 * One row per message.id + requestId (Claude Code repeats usage on every line of a split message; the last line
 * wins). Rows keep first-seen order. Lines without message.id or usage, and <synthetic> API-error replies, are
 * skipped. Ownership across sessions is decided in derive.
 */
export function usageFromLines(lines: StoredLine[]): UsageRow[] {
	const rows = new Map<string, UsageRow>();
	for (const line of lines) {
		if (line.type !== "assistant") continue;
		const message = line.payload.message;
		if (!isObj(message) || typeof message.id !== "string" || !isObj(message.usage)) continue;
		if (message.model === SYNTHETIC) continue;
		const usage = message.usage;
		const requestId = typeof line.payload.requestId === "string" ? line.payload.requestId : null;
		const key = `${message.id}\u0000${requestId ?? ""}`;
		rows.set(key, {
			// an existing key keeps its first-seen position
			model: typeof message.model === "string" ? message.model : "unknown",
			inputTokens: num(usage.input_tokens),
			outputTokens: num(usage.output_tokens),
			cacheCreationTokens: num(usage.cache_creation_input_tokens),
			cacheCreation1hTokens: isObj(usage.cache_creation) ? num(usage.cache_creation.ephemeral_1h_input_tokens) : 0,
			cacheReadTokens: num(usage.cache_read_input_tokens),
			ts: line.ts ?? "",
			messageId: message.id,
			requestId,
			agentId: line.agentId,
		});
	}
	return [...rows.values()];
}

/** The last cost-state line of the main transcript (Claude Code's own /cost totals, Phase 0 A2), else null. */
export function costStateFrom(lines: StoredLine[]): CostState | null {
	let last: Obj | null = null;
	let lastNo = -1;
	for (const line of lines) {
		if (line.agentId !== null || line.type !== "cost-state" || line.lineNo < lastNo) continue;
		if (typeof line.payload.totalCostUSD !== "number") continue;
		last = line.payload;
		lastNo = line.lineNo;
	}
	if (!last) return null;
	const models: CostState["models"] = {};
	if (isObj(last.modelUsage)) {
		for (const [model, m] of Object.entries(last.modelUsage)) {
			if (!isObj(m)) continue;
			models[model] = {
				inputTokens: num(m.inputTokens),
				outputTokens: num(m.outputTokens),
				thinkingTokens: num(m.thinkingTokens),
				cacheReadTokens: num(m.cacheReadInputTokens),
				cacheCreationTokens: num(m.cacheCreationInputTokens),
				costUsd: num(m.costUSD),
			};
		}
	}
	return { totalCostUsd: last.totalCostUSD as number, models };
}

const cleanTitle = (v: unknown): string | null => {
	if (typeof v !== "string") return null;
	const t = v.replace(/\s+/g, " ").trim();
	return t === "" ? null : t;
};

/**
 * Main-transcript titles by lineNo: title = last custom-title, else last ai-title (the CLI and VS Code write only
 * ai-title, Phase 0 A9); agentName = last agent-name. Non-string and blank values are skipped.
 */
export function sessionTitles(lines: StoredLine[]): { title: string | null; agentName: string | null } {
	const latest: Record<string, { lineNo: number; value: string }> = {};
	const fields: Record<string, string> = {
		"custom-title": "customTitle",
		"ai-title": "aiTitle",
		"agent-name": "agentName",
	};
	for (const line of lines) {
		const field = fields[line.type];
		if (!field || line.agentId !== null) continue;
		const value = cleanTitle(line.payload[field]);
		if (value === null) continue;
		const prev = latest[line.type];
		if (!prev || line.lineNo >= prev.lineNo) latest[line.type] = { lineNo: line.lineNo, value };
	}
	return {
		title: latest["custom-title"]?.value ?? latest["ai-title"]?.value ?? null,
		agentName: latest["agent-name"]?.value ?? null,
	};
}

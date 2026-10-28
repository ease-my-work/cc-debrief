// One transcript line: parse, index columns, slim before storage, compress. Ported from the Phase 0 spike
// (slimLineV2, Phase 0 D1; its output is pinned by test/fixtures/synthetic/slim.expected.json).
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { z } from "zod";
import { capField } from "../redact";

type Obj = Record<string, unknown>;

/** Documents the fields ingest relies on; permissive and passthrough, it never rejects unknown keys. */
export const TranscriptLine = z.looseObject({
	uuid: z.string().optional(),
	parentUuid: z.string().nullable().optional(),
	type: z.string().optional(),
	subtype: z.string().optional(),
	timestamp: z.string().optional(),
});

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** A line is ok when it is a JSON object. Hot path: plain JSON.parse, no schema validation. */
export function parseLine(raw: string): { ok: true; line: Obj } | { ok: false } {
	try {
		const v: unknown = JSON.parse(raw.endsWith("\r") ? raw.slice(0, -1) : raw);
		return isObj(v) ? { ok: true, line: v } : { ok: false };
	} catch {
		return { ok: false };
	}
}

/** Indexed columns of transcript_lines; read before slimLine() drops sessionId / cwd. */
export function lineColumns(line: Obj): {
	uuid: string | null;
	parentUuid: string | null;
	type: string;
	subtype: string | null;
	ts: string | null;
} {
	return {
		uuid: str(line.uuid),
		parentUuid: str(line.parentUuid),
		type: str(line.type) ?? "unknown",
		subtype: str(line.subtype) ?? (isObj(line.attachment) ? str(line.attachment.type) : null),
		ts: str(line.timestamp),
	};
}

const omit = (obj: Obj, key: string): Obj => {
	const { [key]: _, ...rest } = obj;
	return rest;
};

// Lines read whole later (titles, cost-state); they are small.
const KEEP_WHOLE = new Set(["custom-title", "agent-name", "ai-title", "cost-state"]);
const HOOK_OUTPUT_TYPES = new Set(["hook_success", "async_hook_response", "hook_additional_context"]);
const HOOK_OUTPUT_FIELDS = ["stdout", "stderr", "content", "response"];
const BOOKKEEPING_TYPES = new Set([
	"prompt_snapshot",
	"total_tokens_reminder",
	"deferred_tools_delta",
	"agent_listing_delta",
	"mcp_instructions_delta",
]);
const HOOK_CAP = 1024;
const RESULT_CAP = 8192;

const resultText = (content: unknown): string =>
	typeof content === "string"
		? content
		: Array.isArray(content)
			? content.map((b) => (isObj(b) && typeof b.text === "string" ? b.text : "")).join("\n")
			: "";

// Keeps type, numbers, booleans and arrays of short identifiers (…Names / …Types); drops long text.
function bookkeeping(a: Obj): Obj {
	const out: Obj = { type: a.type };
	for (const [k, v] of Object.entries(a)) {
		if (k === "type") continue;
		if (typeof v === "number" || typeof v === "boolean") out[k] = v;
		else if (Array.isArray(v) && /(Names|Types)$/.test(k)) out[k] = v;
	}
	return out;
}

const imageStub = (b: Obj): Obj | null =>
	b.type === "image" && isObj(b.source) && typeof b.source.data === "string"
		? { ...b, source: { ...b.source, data: `[image ${b.source.data.length} bytes]` } }
		: null;

function slimAttachment(a: Obj): Obj {
	if (a.type === "instructions" && Array.isArray(a.files)) {
		return { ...a, files: a.files.map((f) => (isObj(f) ? omit(f, "content") : f)) };
	}
	if (a.type === "invoked_skills" && Array.isArray(a.skills)) {
		return { ...a, skills: a.skills.map((s) => (isObj(s) ? omit(s, "content") : s)) };
	}
	if (a.type === "skill_listing") return omit(a, "content");
	if (HOOK_OUTPUT_TYPES.has(a.type as string)) {
		const capped = { ...a };
		for (const f of HOOK_OUTPUT_FIELDS) if (typeof capped[f] === "string") capped[f] = capField(capped[f], HOOK_CAP);
		return capped;
	}
	if (BOOKKEEPING_TYPES.has(a.type as string)) return bookkeeping(a);
	return a;
}

function slimBlock(b: unknown): unknown {
	if (!isObj(b)) return b;
	if (b.type === "thinking" && "signature" in b) return omit(b, "signature");
	if (b.type === "tool_result") {
		if (typeof b.content === "string") return { ...b, content: capField(b.content, RESULT_CAP) };
		if (Array.isArray(b.content)) {
			return {
				...b,
				content: b.content.map((c) =>
					isObj(c) && typeof c.text === "string"
						? { ...c, text: capField(c.text, RESULT_CAP) }
						: isObj(c)
							? (imageStub(c) ?? c)
							: c,
				),
			};
		}
	}
	return imageStub(b) ?? b;
}

/**
 * Drops bulky fields before storage (architecture.md, Phase 0 D1); returns null for lines not stored at all.
 * Never mutates its input. Runs after redactDeep(), so its cuts can never leave part of a secret.
 */
export function slimLine(line: Obj): Obj | null {
	if (line.type === "file-history-snapshot") return null;
	if (KEEP_WHOLE.has(line.type as string)) return line;
	const { sessionId: _s, cwd: _c, ...out } = line;

	if (isObj(out.attachment)) out.attachment = slimAttachment(out.attachment);

	let r = out.toolUseResult;
	if (isObj(r) && "originalFile" in r) r = out.toolUseResult = omit(r, "originalFile");

	const message = out.message;
	if (isObj(message) && Array.isArray(message.content)) {
		const content = message.content;
		// The tool_result already holds what toolUseResult repeats (Bash stdout, a failed call's error string).
		const all = content
			.filter((b) => isObj(b) && b.type === "tool_result")
			.map((b) => resultText((b as Obj).content))
			.join("\n");
		if (typeof r === "string") {
			if (r.length > 0 && all.includes(r)) delete out.toolUseResult;
		} else if (isObj(r)) {
			const kept = { ...r };
			for (const f of ["stdout", "stderr", "content"]) {
				const v = kept[f];
				if (typeof v === "string" && v.length > 0 && all.includes(v)) delete kept[f];
			}
			out.toolUseResult = kept;
		}
		out.message = { ...message, content: content.map(slimBlock) };
	}
	return out;
}

/** Raw deflate of the JSON text (Phase 0 D1); stored as a BLOB. */
export function encodePayload(value: unknown): Uint8Array {
	return deflateRawSync(Buffer.from(JSON.stringify(value), "utf8"));
}

export function decodePayload(blob: Uint8Array): unknown {
	return JSON.parse(inflateRawSync(blob).toString("utf8"));
}

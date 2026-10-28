import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { decodePayload, encodePayload, lineColumns, parseLine, slimLine } from "../../src/ingest/line";
import { fixtureLines } from "../helpers/fixtures";

type Obj = Record<string, unknown>;
const bytes = (s: string) => Buffer.byteLength(s, "utf8");
const marker = /…\[truncated \d+ bytes\]$/;

describe("parseLine", () => {
	it.each([
		['{"type":"user"}', true],
		["{}", true],
		["[]", false],
		["not json", false],
		['"str"', false],
		["null", false],
		['{"type":"user"}\r', true],
	])("%j → ok %s", (raw, ok) => {
		const r = parseLine(raw);
		expect(r.ok).toBe(ok);
		if (r.ok) expect(typeof r.line).toBe("object");
	});
});

describe("slimLine: original rules", () => {
	it("drops file-history-snapshot lines", () => {
		expect(slimLine({ type: "file-history-snapshot", snapshot: {} })).toBeNull();
	});

	it("removes instructions file bodies and keeps their paths", () => {
		const line = {
			type: "attachment",
			attachment: { type: "instructions", files: [{ path: "/r/CLAUDE.md", type: "Project", content: "# big" }] },
		};
		expect(slimLine(line)).toEqual({
			type: "attachment",
			attachment: { type: "instructions", files: [{ path: "/r/CLAUDE.md", type: "Project" }] },
		});
		expect(line.attachment.files[0].content).toBe("# big"); // input not mutated
	});

	it("removes invoked_skills contents, skill_listing content and toolUseResult.originalFile", () => {
		expect(
			slimLine({
				type: "attachment",
				attachment: { type: "invoked_skills", skills: [{ name: "a", content: "body" }] },
			}),
		).toEqual({ type: "attachment", attachment: { type: "invoked_skills", skills: [{ name: "a" }] } });
		expect(
			slimLine({ type: "attachment", attachment: { type: "skill_listing", content: "- a: b", names: ["a"] } }),
		).toEqual({ type: "attachment", attachment: { type: "skill_listing", names: ["a"] } });
		const line = { type: "user", toolUseResult: { filePath: "/r/x.ts", originalFile: "old" } };
		expect(slimLine(line)).toEqual({ type: "user", toolUseResult: { filePath: "/r/x.ts" } });
		expect(line.toolUseResult.originalFile).toBe("old");
	});
});

const resultLine = (content: unknown, toolUseResult: unknown): Obj => ({
	type: "user",
	message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content }] },
	toolUseResult,
});

describe("slimLine: Phase 0 D1 rules", () => {
	it("drops toolUseResult fields the tool_result already contains, keeps different ones", () => {
		const out = slimLine(resultLine("same text", { stdout: "same text", stderr: "other", interrupted: false })) as Obj;
		expect(out.toolUseResult).toEqual({ stderr: "other", interrupted: false });
		const str = slimLine(resultLine([{ type: "text", text: "Exit code 1\nboom" }], "Exit code 1\nboom")) as Obj;
		expect("toolUseResult" in str).toBe(false);
		const differs = slimLine(resultLine("Exit code 1", "Error: Exit code 1")) as Obj;
		expect(differs.toolUseResult).toBe("Error: Exit code 1");
	});

	it("drops thinking signatures", () => {
		const out = slimLine({
			type: "assistant",
			message: { content: [{ type: "thinking", thinking: "hm", signature: "sig" }] },
		}) as Obj;
		expect(out.message).toEqual({ content: [{ type: "thinking", thinking: "hm" }] });
	});

	it("caps hook output at 1 KB and tool_result text at 8 KB", () => {
		const hook = slimLine({
			type: "attachment",
			attachment: { type: "hook_success", stdout: "h".repeat(3000), stderr: "", exitCode: 0 },
		}) as { attachment: Obj };
		expect(bytes(hook.attachment.stdout as string)).toBeLessThanOrEqual(1024);
		expect(hook.attachment.stdout).toMatch(marker);
		expect(hook.attachment.exitCode).toBe(0);

		const big = "r".repeat(20_000);
		const asString = slimLine(resultLine(big, { other: 1 })) as { message: { content: Obj[] } };
		expect(bytes(asString.message.content[0].content as string)).toBeLessThanOrEqual(8192);
		expect(asString.message.content[0].content).toMatch(marker);
		const asBlocks = slimLine(resultLine([{ type: "text", text: big }], { other: 1 })) as {
			message: { content: { content: Obj[] }[] };
		};
		expect(bytes(asBlocks.message.content[0].content[0].text as string)).toBeLessThanOrEqual(8192);
	});

	it("replaces image data, also inside tool results", () => {
		const img = { type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(500) } };
		const out = slimLine({ type: "user", message: { content: [img, { type: "tool_result", content: [img] }] } }) as {
			message: { content: [Obj, { content: Obj[] }] };
		};
		expect(out.message.content[0]).toEqual({ ...img, source: { ...img.source, data: "[image 500 bytes]" } });
		expect(out.message.content[1].content[0]).toEqual({ ...img, source: { ...img.source, data: "[image 500 bytes]" } });
	});

	it("reduces bookkeeping attachments to type, numbers, booleans and name lists", () => {
		const out = slimLine({
			type: "attachment",
			attachment: {
				type: "deferred_tools_delta",
				addedNames: ["A", "B"],
				addedLines: ["A long line", "B long line"],
				failedMcpServers: [{ name: "x", error: "y" }],
				count: 2,
				initial: true,
				note: "text",
			},
		});
		expect(out).toEqual({
			type: "attachment",
			attachment: { type: "deferred_tools_delta", addedNames: ["A", "B"], count: 2, initial: true },
		});
	});

	it("drops per-line sessionId and cwd", () => {
		expect(slimLine({ type: "user", sessionId: "s", cwd: "/r", uuid: "u" })).toEqual({ type: "user", uuid: "u" });
	});

	it.each([
		{ type: "ai-title", aiTitle: "T", sessionId: "s" },
		{ type: "custom-title", customTitle: "T", sessionId: "s" },
		{ type: "agent-name", agentName: "A", sessionId: "s" },
		{ type: "cost-state", sessionId: "s", totalCostUSD: 1.5, modelUsage: { m: { costUSD: 1.5 } } },
	])("keeps a $type line whole", (line) => {
		expect(slimLine(line)).toEqual(line);
	});
});

describe("slimLine snapshot", () => {
	// test/fixtures/synthetic/slim.expected.json: a hash of the Phase 0 spike's slimLineV2 output per fixture line
	// (generated before spike/ was deleted). Lines kept whole (architecture.md) are the one intended difference.
	const KEPT_WHOLE = new Set(["ai-title", "custom-title", "agent-name", "cost-state"]);
	const canon = (v: unknown): unknown =>
		Array.isArray(v)
			? v.map(canon)
			: v && typeof v === "object"
				? Object.fromEntries(
						Object.keys(v)
							.sort()
							.map((k) => [k, canon((v as Record<string, unknown>)[k])]),
					)
				: v;
	const hash = (v: unknown) =>
		createHash("sha256")
			.update(JSON.stringify(canon(v) ?? null))
			.digest("hex")
			.slice(0, 16);

	it("matches the stored snapshot on every fixture line except the lines kept whole", () => {
		const expected: Record<string, string> = JSON.parse(
			readFileSync(resolve(import.meta.dirname, "../fixtures/synthetic/slim.expected.json"), "utf8"),
		);
		let compared = 0;
		for (const { label, raw } of fixtureLines()) {
			const line = JSON.parse(raw);
			if (KEPT_WHOLE.has(line.type)) continue;
			const key = label.replaceAll("\\", "/");
			const got = slimLine(line);
			expect(hash(got), `${key}: ${JSON.stringify(got)?.slice(0, 300)}`).toBe(expected[key]);
			compared++;
		}
		expect(compared).toBe(Object.keys(expected).length);
	});
});

describe("encodePayload / decodePayload", () => {
	it("round-trips every fixture line", () => {
		for (const { label, raw } of fixtureLines()) {
			const value = JSON.parse(raw);
			const blob = encodePayload(value);
			expect(blob).toBeInstanceOf(Uint8Array);
			expect(decodePayload(blob), label).toEqual(value);
		}
	});

	it("compresses a 4 KB line", () => {
		const value = { type: "user", message: { content: "The quick brown fox. ".repeat(200) } };
		expect(bytes(JSON.stringify(value))).toBeGreaterThan(4000);
		expect(encodePayload(value).length).toBeLessThan(bytes(JSON.stringify(value)) / 4);
	});
});

describe("lineColumns", () => {
	it("extracts uuid, parentUuid, type, subtype and ts", () => {
		expect(
			lineColumns({ type: "assistant", uuid: "u2", parentUuid: "u1", timestamp: "2026-09-01T10:00:00.000Z" }),
		).toEqual({ uuid: "u2", parentUuid: "u1", type: "assistant", subtype: null, ts: "2026-09-01T10:00:00.000Z" });
		expect(lineColumns({ type: "system", subtype: "compact_boundary", uuid: "u3", parentUuid: null })).toEqual({
			uuid: "u3",
			parentUuid: null,
			type: "system",
			subtype: "compact_boundary",
			ts: null,
		});
	});

	it("uses the attachment type as subtype for attachment lines", () => {
		expect(lineColumns({ type: "attachment", attachment: { type: "instructions" }, uuid: "u4" })).toMatchObject({
			type: "attachment",
			subtype: "instructions",
		});
	});

	it("falls back to unknown for a line without type and ignores non-string values", () => {
		expect(lineColumns({ uuid: 5, timestamp: 7 })).toEqual({
			uuid: null,
			parentUuid: null,
			type: "unknown",
			subtype: null,
			ts: null,
		});
	});
});

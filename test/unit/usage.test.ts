import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type StoredLine, usageFromLines } from "../../src/collector/transcript";
import { FIXTURES, phase0Cases, readExpected, storedLines } from "../helpers/fixtures";

const basic = readExpected("basic");
const basicLines = () => storedLines(join(FIXTURES, "synthetic", "basic"));

const assistant = (lineNo: number, payload: Record<string, unknown>, agentId: string | null = null): StoredLine => ({
	lineNo,
	agentId,
	uuid: `u${lineNo}`,
	type: "assistant",
	subtype: null,
	ts: `2026-09-01T10:00:0${lineNo}.000Z`,
	payload: { type: "assistant", ...payload },
});

describe("usageFromLines", () => {
	it("gives the basic fixture's rows: split message counted once, subagent rows with agentId", () => {
		const rows = usageFromLines(basicLines());
		const expected = basic.usage.map(({ turnSeq: _t, ...rest }: Record<string, unknown>) => rest);
		expect(rows.map(({ ts: _ts, cacheCreation1hTokens: _c, ...rest }) => rest)).toEqual(expected);
	});

	it("keeps the last line of a split message, including its timestamp", () => {
		const msgA = usageFromLines(basicLines()).find((r) => r.messageId === "msg_A");
		expect(msgA).toMatchObject({ outputTokens: 20, ts: "2026-09-01T10:00:03.000Z" });
	});

	it("counts missing usage fields as 0 and reads the 1-hour cache-write share", () => {
		const rows = usageFromLines([
			assistant(1, { requestId: "r1", message: { id: "m1", model: "claude-opus-5-5", usage: { output_tokens: 5 } } }),
			assistant(2, {
				requestId: "r2",
				message: {
					id: "m2",
					model: "claude-opus-5-5",
					usage: {
						input_tokens: 1,
						cache_creation_input_tokens: 300,
						cache_creation: { ephemeral_1h_input_tokens: 200, ephemeral_5m_input_tokens: 100 },
					},
				},
			}),
		]);
		expect(rows).toEqual([
			{
				model: "claude-opus-5-5",
				inputTokens: 0,
				outputTokens: 5,
				cacheCreationTokens: 0,
				cacheCreation1hTokens: 0,
				cacheReadTokens: 0,
				ts: "2026-09-01T10:00:01.000Z",
				messageId: "m1",
				requestId: "r1",
				agentId: null,
			},
			expect.objectContaining({
				messageId: "m2",
				inputTokens: 1,
				cacheCreationTokens: 300,
				cacheCreation1hTokens: 200,
			}),
		]);
	});

	it("keys on message id and request id, a missing request id counting as its own key", () => {
		const msg = (id: string) => ({ id, model: "m", usage: { output_tokens: 1 } });
		const rows = usageFromLines([
			assistant(1, { requestId: "r1", message: msg("m1") }),
			assistant(2, { requestId: "r2", message: msg("m1") }),
			assistant(3, { message: msg("m1") }),
			assistant(4, { message: msg("m1") }),
		]);
		expect(rows.map((r) => [r.messageId, r.requestId])).toEqual([
			["m1", "r1"],
			["m1", "r2"],
			["m1", null],
		]);
	});

	it("skips non-assistant lines and lines without a message id or usage", () => {
		const rows = usageFromLines([
			{ ...assistant(1, { message: { id: "m1", model: "m", usage: { output_tokens: 1 } } }), type: "user" },
			assistant(2, { message: { model: "m", usage: { output_tokens: 1 } } }),
			assistant(3, { message: { id: "m3", model: "m" } }),
		]);
		expect(rows).toEqual([]);
	});

	it("skips <synthetic> API-error replies in every Phase 0 fixture", () => {
		let synthetic = 0;
		for (const { dir } of phase0Cases()) {
			const lines = storedLines(dir);
			synthetic += lines.filter(
				(l) => (l.payload.message as { model?: string } | undefined)?.model === "<synthetic>",
			).length;
			expect(usageFromLines(lines).some((r) => r.model === "<synthetic>")).toBe(false);
		}
		expect(synthetic).toBeGreaterThan(0); // the fixtures do contain some
	});
});

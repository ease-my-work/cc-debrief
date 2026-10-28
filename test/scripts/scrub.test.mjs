import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compilePattern, DEFAULT_REDACT } from "../../scripts/lib/redact.mjs";
import { buildReplacements, findLeaks, scrubFixture, scrubJson, scrubText } from "../../scripts/lib/scrub.mjs";
import { tmpDir, writeJsonl } from "../helpers/tmp.mjs";

const map = {
	home: "C:\\Users\\alice",
	username: "alice",
	emails: ["alice@corp.com"],
	replace: { AcmeCorp: "example-org" },
};
const reps = buildReplacements(map);
const pats = DEFAULT_REDACT.map(compilePattern);

describe("scrubText", () => {
	it("replaces home in raw, JSON-escaped, slash and encoded forms", () => {
		const line = JSON.stringify({
			cwd: "C:\\Users\\alice\\src\\AcmeCorp",
			dir: "C--Users-alice-src",
			unix: "/c/Users/alice/x",
		});
		const out = scrubText(line, reps, pats);
		expect(out).not.toMatch(/alice|AcmeCorp/);
		expect(JSON.parse(out).cwd).toBe("C:\\Users\\user\\src\\example-org");
	});
	it("redacts secrets and emails", () => {
		const out = scrubText(`token ghp_${"a".repeat(36)} from bob@other.org`, reps, pats);
		expect(out).toContain("[REDACTED]");
		expect(out).toContain("user@example.com");
	});
	it("does not touch the username inside longer identifiers", () => {
		const r = buildReplacements({ home: "C:\\Users\\X1", username: "X1", emails: [], replace: {} });
		expect(scrubText("0xX1F X11 X1 c:\\users\\x1\\a", r, pats)).toBe("0xX1F X11 user C:\\Users\\user\\a");
	});
});

describe("account ids", () => {
	it("blanks organization and account uuids wherever they appear", () => {
		const line = JSON.stringify({
			type: "attachment",
			attachment: { type: "credential_org", organizationUuid: "1b2c3d4e-0000-4000-8000-123456789abc" },
			nested: [{ accountUuid: "9f8e7d6c-0000-4000-8000-cba987654321" }],
		});
		const out = JSON.parse(scrubJson(line, reps, pats));
		expect(out.attachment.organizationUuid).toBe("00000000-0000-0000-0000-000000000000");
		expect(out.nested[0].accountUuid).toBe("00000000-0000-0000-0000-000000000000");
	});
	it("flags an account uuid left in a fixture", () => {
		const kinds = findLeaks('{"organizationUuid":"1b2c3d4e-0000-4000-8000-123456789abc"}', { patterns: pats }).map(
			(l) => l.kind,
		);
		expect(kinds).toEqual(["account-id"]);
		expect(findLeaks('{"organizationUuid":"00000000-0000-0000-0000-000000000000"}', { patterns: pats })).toEqual([]);
	});
});

describe("artifact links", () => {
	it("replaces real claude.ai artifact ids but keeps documentation placeholders", () => {
		const out = scrubText(
			"see https://claude.ai/artifact/UPPX71SpPMkGT2BASWa and claude.ai/code/artifact/0f1e2d3c-aaaa-bbbb-cccc-123456789012, not claude.ai/artifact/{id}",
			reps,
			pats,
		);
		expect(out).toBe(
			"see https://claude.ai/artifact/example-artifact and claude.ai/code/artifact/example-artifact, not claude.ai/artifact/{id}",
		);
	});
	it("flags a real artifact id left in a fixture", () => {
		expect(findLeaks("https://claude.ai/artifact/UPPX71SpPMkGT2BASWa", { patterns: pats }).map((l) => l.kind)).toEqual([
			"artifact-url",
		]);
		expect(findLeaks("claude.ai/artifact/example-artifact claude.ai/artifact/{id}", { patterns: pats })).toEqual([]);
	});
});

describe("findLeaks", () => {
	it("flags home paths, emails, map terms and secrets", () => {
		const kinds = findLeaks(`C:\\\\Users\\\\bob\\\\x alice@corp.com AcmeCorp sk-ant-api03-${"x".repeat(30)}`, {
			replacements: reps,
			patterns: pats,
		}).map((l) => l.kind);
		expect(kinds).toEqual(expect.arrayContaining(["home-path", "email", "map-term", "secret"]));
	});
	it("passes clean text", () => {
		expect(findLeaks("C:\\\\Users\\\\user\\\\x user@example.com", { replacements: reps, patterns: pats })).toEqual([]);
	});
	it("does not read a JSON escape before an @-import as an email", () => {
		const raw = JSON.stringify({ content: "Use rtk for everything else.\n\n@RTK.md" });
		expect(findLeaks(raw, { patterns: pats })).toEqual([]);
		expect(scrubText(raw, reps, pats)).toBe(raw);
		expect(findLeaks("mail bob@other.org now", { patterns: pats }).map((l) => l.kind)).toEqual(["email"]);
	});
	it("does not flag text that is already redacted", () => {
		expect(findLeaks('password: [REDACTED] "api_key": "[REDACTED]"', { patterns: pats })).toEqual([]);
	});
});

it("scrubFixture copies main and subagent files, keeps JSON valid, writes case.json", () => {
	const projects = tmpDir();
	const proj = join(projects, "C--Users-alice-src-AcmeCorp");
	writeJsonl(join(proj, "S1.jsonl"), [{ sessionId: "S1", version: "2.5.0", cwd: "C:\\Users\\alice\\src\\AcmeCorp" }]);
	writeJsonl(join(proj, "S1", "subagents", "agent-a1.jsonl"), [{ sessionId: "S1", cwd: "C:\\Users\\alice" }]);
	const dest = join(tmpDir(), "case");
	const r = scrubFixture({
		sessionId: "S1",
		projectsDir: projects,
		destDir: dest,
		map,
		surface: "cli",
		os: "windows",
		caseName: "basic",
		covers: ["subagent"],
	});
	expect(r.files).toBe(2);
	expect(readFileSync(join(dest, "S1.jsonl"), "utf8")).not.toMatch(/alice|AcmeCorp/);
	expect(readdirSync(join(dest, "S1", "subagents"))).toEqual(["agent-a1.jsonl"]);
	expect(JSON.parse(readFileSync(join(dest, "case.json"), "utf8"))).toMatchObject({
		surface: "cli",
		ccVersion: "2.5.0",
		covers: ["subagent"],
	});
});

it("scrubFixture redacts a secret that is JSON-escaped inside a message", () => {
	const projects = tmpDir();
	writeJsonl(join(projects, "p", "S2.jsonl"), [
		{ sessionId: "S2", message: { content: 'config: {"api_key": "abcd1234efgh"}' } },
	]);
	const dest = join(tmpDir(), "case");
	scrubFixture({
		sessionId: "S2",
		projectsDir: projects,
		destDir: dest,
		map,
		surface: "cli",
		os: "linux",
		caseName: "c",
		covers: [],
	});
	const text = readFileSync(join(dest, "S2.jsonl"), "utf8");
	expect(text).not.toContain("abcd1234efgh");
	expect(JSON.parse(text).message.content).toContain("[REDACTED]");
});

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
	capField,
	compilePattern,
	DEFAULT_HINT,
	DEFAULT_REDACT,
	expandPatterns,
	redact,
	redactDeep,
} from "../../src/redact";
import { fixtureLines } from "../helpers/fixtures";

const R = "[REDACTED]";
const bytes = (s: string) => Buffer.byteLength(s, "utf8");

// Samples are built at runtime so no token-shaped literal sits in the repo.
// [index in DEFAULT_REDACT, name, positive input, expected output, near-miss negative]
const CASES: [number, string, string, string, string][] = [
	[0, "anthropic key", `key sk-ant-api03-${"A".repeat(24)} end`, `key ${R} end`, "key sk-ant-short end"],
	[1, "openai key", `k=sk-proj-${"a1".repeat(12)}`, `k=${R}`, `task-${"a".repeat(24)}`],
	[2, "aws key id", "id AKIAIOSFODNN7EXAMPLE x", `id ${R} x`, "id AKIAIOSFODNN7EXAMPL x"],
	[
		3,
		"aws secret",
		"aws_secret_access_key = wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
		`aws_secret_access_key = ${R}`,
		"aws_access_key_id = wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
	],
	[4, "github classic", `t ghp_${"A".repeat(36)} t`, `t ${R} t`, `t ghp_${"A".repeat(35)} t`],
	[5, "github fine-grained", `t github_pat_${"A".repeat(22)} t`, `t ${R} t`, `t github_pat_${"A".repeat(21)} t`],
	[6, "bearer", "Authorization: Bearer abcdefghijklmnop1234", `Authorization: Bearer ${R}`, "Bearer short"],
	[
		7,
		"pem private key",
		"a\n-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----\nb",
		`a\n${R}\nb`,
		"-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkq\n-----END PUBLIC KEY-----",
	],
	[
		8,
		"generic assignment",
		`{"api_key": "abcd1234"} password=hunter22`,
		`{"api_key": "${R}"} password=${R}`,
		"password=abc",
	],
	[9, "url password", "https://u:hunter22@db.local/x", `https://u:${R}@db.local/x`, "https://db.local:5432/x@y"],
	[10, "slack", `xoxb-${"1".repeat(12)}`, R, `xoxz-${"1".repeat(12)}`],
	[11, "google api key", `k AIza${"B".repeat(35)} k`, `k ${R} k`, `k AIza${"B".repeat(34)} k`],
	[
		12,
		"jwt",
		`t eyJ${"a".repeat(10)}.eyJ${"b".repeat(10)}.${"c".repeat(10)} t`,
		`t ${R} t`,
		`t eyJ${"a".repeat(10)}.eyJ${"b".repeat(10)} t`,
	],
];

describe("DEFAULT_REDACT", () => {
	it("has the 13 feature-14 patterns, each covered by a case", () => {
		expect(DEFAULT_REDACT).toHaveLength(13);
		expect(CASES.map((c) => c[0])).toEqual([...DEFAULT_REDACT.keys()]);
	});

	it.each(CASES)("pattern %i (%s): redacts the positive sample", (i, _name, input, expected) => {
		expect(redact(input, [DEFAULT_REDACT[i]])).toBe(expected);
	});

	it.each(CASES)("pattern %i (%s): leaves the near miss intact", (i, _name, _in, _out, negative) => {
		expect(redact(negative, [DEFAULT_REDACT[i]])).toBe(negative);
	});

	it("redacts the feature 14 example with the full default list", () => {
		const input = `curl -H "Authorization: Bearer sk-ant-api03-${"x".repeat(30)}" https://u:hunter22@db.local`;
		expect(redact(input, DEFAULT_REDACT)).toBe(`curl -H "Authorization: Bearer ${R}" https://u:${R}@db.local`);
	});
});

describe("compilePattern", () => {
	it("compiles /body/flags with the given flags plus g", () => {
		const re = compilePattern("/abc/i");
		expect(re?.source).toBe("abc");
		expect(re?.flags).toBe("gi");
	});

	it("compiles a plain body with g", () => {
		const re = compilePattern("a/b");
		expect(re?.source).toBe("a\\/b");
		expect(re?.flags).toBe("g");
	});

	it("returns null without throwing for an invalid regex or flags", () => {
		expect(compilePattern("/(/")).toBeNull();
		expect(compilePattern("(")).toBeNull();
		expect(compilePattern("/a/zz")).toBeNull();
	});

	it("redact skips a pattern that does not compile", () => {
		expect(redact("password=hunter22 (", ["(", "@default"])).toBe(`password=${R} (`);
	});
});

describe("expandPatterns", () => {
	it("replaces @default in place", () => {
		expect(expandPatterns(["a", "@default", "x"])).toEqual(["a", ...DEFAULT_REDACT, "x"]);
		expect(expandPatterns(["@default", "x"])).toEqual([...DEFAULT_REDACT, "x"]);
	});
});

describe("capField", () => {
	const marker = /…\[truncated (\d+) bytes\]$/;

	function checkCut(text: string, max: number) {
		const out = capField(text, max);
		expect(bytes(out)).toBeLessThanOrEqual(max);
		const m = marker.exec(out);
		expect(m).not.toBeNull();
		const prefix = out.slice(0, out.length - (m as RegExpExecArray)[0].length);
		expect(text.startsWith(prefix)).toBe(true);
		expect(bytes(prefix) + Number((m as RegExpExecArray)[1])).toBe(bytes(text));
		expect(out).not.toContain("�");
		return { out, prefix };
	}

	it("returns text at or under the limit unchanged", () => {
		expect(capField("abc", 3)).toBe("abc");
		expect(capField("é".repeat(5), 10)).toBe("é".repeat(5));
	});

	it("cuts ASCII to the longest prefix that fits with the marker", () => {
		const { out, prefix } = checkCut("a".repeat(1000), 100);
		expect(bytes(out)).toBe(100);
		expect(prefix.length).toBe(100 - bytes("…[truncated 922 bytes]"));
	});

	it("cuts one byte over the limit", () => {
		checkCut("a".repeat(101), 100);
	});

	it("never splits a multibyte code point", () => {
		for (let max = 30; max < 40; max++) {
			checkCut("é".repeat(100), max);
			checkCut("😀".repeat(100), max);
			checkCut(`a${"€".repeat(100)}`, max);
		}
	});

	it("stays within a limit smaller than the marker", () => {
		expect(bytes(capField("a".repeat(100), 5))).toBeLessThanOrEqual(5);
	});
});

describe("redactDeep", () => {
	it("redacts a secret straddling the cut before capping", () => {
		const secret = `ghp_${"Z".repeat(40)}`;
		const text = `${"a".repeat(90)} ${secret} ${"b".repeat(200)}`; // cut at ~126 falls inside the secret
		const out = redactDeep({ text }, DEFAULT_REDACT, 150).text;
		expect(bytes(out)).toBeLessThanOrEqual(150);
		expect(out).toContain(R);
		expect(out).not.toContain("ghp_");
		expect(out).not.toContain("ZZZZ");
	});

	it("changes string leaves only and does not mutate the input", () => {
		const input = {
			a: "password=hunter22",
			n: 1,
			z: null,
			b: true,
			arr: [`sk-ant-api03-${"q".repeat(24)}`, 2, { deep: "x".repeat(50) }],
		};
		const before = structuredClone(input);
		const out = redactDeep(input, DEFAULT_REDACT, 40);
		expect(input).toEqual(before);
		expect(out).toEqual({
			a: `password=${R}`,
			n: 1,
			z: null,
			b: true,
			arr: [R, 2, { deep: capField("x".repeat(50), 40) }],
		});
		expect(out.arr).not.toBe(input.arr);
	});

	it("expands @default", () => {
		expect(redactDeep(["password=hunter22"], ["@default"], 100)).toEqual([`password=${R}`]);
	});
});

describe("drift", () => {
	it("scripts/lib/redact.mjs DEFAULT_REDACT matches src/redact.ts", async () => {
		const url = pathToFileURL(resolve(import.meta.dirname, "../../scripts/lib/redact.mjs")).href;
		const mod = (await import(url)) as { DEFAULT_REDACT: string[] };
		expect(mod.DEFAULT_REDACT).toEqual(DEFAULT_REDACT);
	});
});

describe("DEFAULT_HINT prefilter", () => {
	// Every string any default pattern matches must contain the hint, or redaction would skip a secret.
	const variants = [
		...CASES.flatMap(([, , pos, , neg]) => [pos, neg]),
		"AUTHORIZATION: BEARER abcdefghijklmnop1234",
		"Client_Secret: s3cr3tvalue",
		'"API-KEY": "abcdefgh"',
		"Access-Token=abcdefgh",
		"AUTH_TOKEN: zzzzzzzz",
		"PWD=hunter22",
		"Passwd: hunter22",
		"AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
		"-----BEGIN ENCRYPTED PRIVATE KEY-----\nabc\n-----END ENCRYPTED PRIVATE KEY-----",
		"postgres://admin:pa55word@db:5432/app",
		`ASIA${"Q".repeat(16)}`,
		`gho_${"x".repeat(40)}`,
		`xoxp-${"9".repeat(20)}`,
	];
	const leaves = (v: unknown, out: string[] = []): string[] => {
		if (typeof v === "string") out.push(v);
		else if (Array.isArray(v)) for (const x of v) leaves(x, out);
		else if (v && typeof v === "object") for (const x of Object.values(v)) leaves(x, out);
		return out;
	};
	const fixtureStrings = () => fixtureLines().flatMap(({ raw }) => leaves(JSON.parse(raw)));

	it("is found in every string a default pattern matches", () => {
		for (const s of [...variants, ...fixtureStrings()]) {
			const matched = DEFAULT_REDACT.some((p) => {
				const re = compilePattern(p) as RegExp;
				re.lastIndex = 0;
				return re.test(s);
			});
			if (matched) expect(DEFAULT_HINT.test(s), s.slice(0, 200)).toBe(true);
		}
	});

	it("leaves redactDeep's output unchanged on every fixture line and sample", () => {
		const naive = (s: string) => DEFAULT_REDACT.reduce((acc, p) => acc.replace(compilePattern(p) as RegExp, R), s);
		for (const s of [...variants, ...fixtureStrings()]) {
			expect(redactDeep(s, ["@default"], 1 << 30)).toBe(naive(s));
		}
	});
});

// Source and docs are plain UTF-8: no byte-order mark (a literal U+FEFF character, also inside code, where the
// escape sequence belongs) and no UTF-8 text that went through a cp1252 round trip (an ellipsis turning into three
// Latin-1 characters), which Windows tools can produce and which silently breaks string literals and regexes.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const DIRS = ["src", "test", "scripts", "docs"];
const SKIP = [join("test", "fixtures")]; // captured data, kept byte for byte
const EXT = /\.(ts|mts|mjs|cjs|js|json|md|sql)$/;
const BOM = String.fromCharCode(0xfeff);
// A lead byte of a 2- or 3-byte UTF-8 sequence read as cp1252, followed by a cp1252 continuation character.
const DOUBLE_ENCODED = /[ÂÃâ][\u0080-¿–-›€™]/;

function files(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (SKIP.some((s) => relative(root, p).startsWith(s)) || name === "node_modules") continue;
		if (statSync(p).isDirectory()) files(p, out);
		else if (EXT.test(name)) out.push(p);
	}
	return out;
}

describe("source encoding", () => {
	it("has no byte-order mark and no double-encoded UTF-8 in src, test, scripts or docs", () => {
		const bad: string[] = [];
		for (const f of DIRS.flatMap((d) => files(join(root, d)))) {
			const text = readFileSync(f, "utf8");
			const rel = relative(root, f);
			if (text.includes(BOM)) bad.push(`${rel}: U+FEFF`);
			const m = DOUBLE_ENCODED.exec(text);
			if (m) bad.push(`${rel}: ${JSON.stringify(text.slice(Math.max(0, m.index - 20), m.index + 20))}`);
		}
		expect(bad).toEqual([]);
	});
});

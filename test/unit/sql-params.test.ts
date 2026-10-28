// node:sqlite in Node 22.13 (our engines floor) binds positional arguments wrongly once a statement uses numbered
// parameters such as ?1 ("column index out of range"); newer 22.x accepts them, so only the 22.13.0 CI jobs failed.
// SQL in src/ uses plain ? (repeat the argument instead).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "../../src");

function files(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		return statSync(path).isDirectory() ? files(path) : path.endsWith(".ts") ? [path] : [];
	});
}

describe("SQL parameters", () => {
	it("src/ uses no numbered parameters (?1, ?2, …)", () => {
		const hits = files(root).flatMap((path) =>
			readFileSync(path, "utf8")
				.split("\n")
				.flatMap((line, i) => (/\?\d/.test(line) ? [`${relative(root, path)}:${i + 1}: ${line.trim()}`] : [])),
		);
		expect(hits).toEqual([]);
	});
});

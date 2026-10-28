import { describe, expect, it } from "vitest";
import pkg from "../../package.json" with { type: "json" };
import { VERSION } from "../../src/version";

describe("VERSION", () => {
	it("equals the package.json version", () => {
		expect(VERSION).toBe(pkg.version);
	});
});

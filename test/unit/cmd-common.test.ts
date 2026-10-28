import { homedir } from "node:os";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { count, tilde } from "../../src/commands/common";

describe("tilde", () => {
	it("shows the home directory as ~", () => {
		expect(tilde(join(homedir(), ".cc-debrief", "tracker.db"))).toBe(`~${sep}.cc-debrief${sep}tracker.db`);
		expect(tilde(homedir())).toBe("~");
	});

	it("leaves other paths and look-alike prefixes alone", () => {
		expect(tilde(`${homedir()}x${sep}y`)).toBe(`${homedir()}x${sep}y`);
		const other = process.platform === "win32" ? "D:\\data\\x" : "/opt/data/x";
		expect(tilde(other)).toBe(other);
	});

	it.runIf(process.platform === "win32")("matches a home path written with forward slashes on Windows", () => {
		expect(tilde(`${homedir().replaceAll("\\", "/")}/.cc-debrief`)).toBe("~\\.cc-debrief");
	});
});

describe("count", () => {
	it("pluralises and groups thousands", () => {
		expect(count(1, "hook")).toBe("1 hook");
		expect(count(0, "session")).toBe("0 sessions");
		expect(count(1812, "line")).toBe("1,812 lines");
		expect(count(2, "parse error")).toBe("2 parse errors");
	});
});

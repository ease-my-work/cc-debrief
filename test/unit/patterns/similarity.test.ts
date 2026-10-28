import { describe, expect, it } from "vitest";
import { fingerprintText, type Step, toolSkeleton, trigramJaccard } from "../../../src/patterns/fingerprint";
import { normalizeLabel, sameLabel } from "../../../src/patterns/labels";
import { terms, tfidfCosine } from "../../../src/patterns/similarity";

const call = (tool_name: string, input: Record<string, unknown> = {}, mcp_server: string | null = null) => ({
	tool_name,
	input,
	mcp_server,
});

describe("toolSkeleton", () => {
	it("steps by command key, basename and MCP server, consecutive duplicates collapsed", () => {
		const steps = toolSkeleton([
			call("Bash", { command: "trivy image x" }),
			call("Read", { file_path: "/repo/Dockerfile" }),
			call("Edit", { file_path: "./Dockerfile" }),
			call("Edit", { file_path: "Dockerfile" }),
			call("Bash", { command: "docker build ." }),
			call("mcp__postgres__query", {}, "postgres"),
		]);
		expect(steps).toEqual(["Bash:trivy", "Read:Dockerfile", "Edit:Dockerfile", "Bash:docker build", "mcp:postgres"]);
		expect(fingerprintText(steps.slice(0, 3))).toBe("Bash:trivy → Read:Dockerfile → Edit:Dockerfile");
	});

	it("npm test then npm run build are two steps", () => {
		expect(toolSkeleton([call("Bash", { command: "npm test" }), call("Bash", { command: "npm run build" })])).toEqual([
			"Bash:npm test",
			"Bash:npm run",
		]);
	});

	it("other tools have an empty argument; Windows paths use their basename", () => {
		expect(
			toolSkeleton([
				call("Grep", { pattern: "x" }),
				call("TodoWrite"),
				call("Write", { file_path: "C:\\r\\src\\a.ts" }),
			]),
		).toEqual(["Grep:", "TodoWrite:", "Write:a.ts"]);
	});
});

describe("trigramJaccard", () => {
	const five: Step[] = ["a:", "b:", "c:", "d:", "e:"];
	it("identical skeletons score 1", () => {
		expect(trigramJaccard(five, [...five])).toBe(1);
	});

	it("one differing step in five: trigrams abc bcd cde vs abc bcx cxe → 1 / 5", () => {
		expect(trigramJaccard(five, ["a:", "b:", "c:", "x:", "e:"])).toBeCloseTo(1 / 5, 12);
	});

	it("fewer than 3 distinct steps on either side scores 0", () => {
		expect(trigramJaccard(["a:", "b:", "a:", "b:"], five)).toBe(0);
		expect(trigramJaccard(five, ["a:", "b:"])).toBe(0);
	});
});

describe("tfidfCosine", () => {
	it("is symmetric with a unit diagonal; identical docs 1, disjoint docs 0", () => {
		const m = tfidfCosine(["fix the trivy findings", "fix the trivy findings", "rename config loader", ""]);
		expect(m[0][0]).toBe(1);
		expect(m[0][1]).toBeCloseTo(1, 12);
		expect(m[0][2]).toBe(0);
		expect(m[2][0]).toBe(m[0][2]);
		expect(m[3][3]).toBe(0); // no terms
	});

	it("partial overlap lands between 0 and 1, symmetric", () => {
		const m = tfidfCosine(["bump trivy base image", "fix trivy findings dockerfile", "add login endpoint"]);
		expect(m[0][1]).toBeGreaterThan(0);
		expect(m[0][1]).toBeLessThan(1);
		expect(m[1][0]).toBe(m[0][1]);
	});
});

describe("labels", () => {
	it("terms drop stopwords and short tokens and stem lightly", () => {
		expect(terms("Please use the cached findings, fixed in DB")).toEqual(["cach", "find", "fix"]);
	});

	it('normalizeLabel("Fixing Trivy findings!") is "fix trivy find"', () => {
		expect(normalizeLabel("Fixing Trivy findings!")).toBe("fix trivy find");
	});

	it("sameLabel: equal after normalization, or token Jaccard ≥ 0.8", () => {
		expect(sameLabel("fix trivy findings", "fixed trivy finding")).toBe(true);
		expect(sameLabel("fix trivy findings in Dockerfile", "fix trivy findings")).toBe(false); // 3 / 4 = 0.75
		expect(sameLabel("add alembic column migration", "add alembic column migrations")).toBe(true);
		expect(sameLabel("", "")).toBe(false);
	});
});

// Phase 7 Task 10 (spec decision 7): replies and plans render as Markdown with no raw HTML, no images and safe links.
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Markdown } from "../../ui/src/components/Markdown";

describe("Markdown", () => {
	it("renders Markdown structure", () => {
		const { container } = render(<Markdown text={"# Title\n\n**bold** and `code`\n\n- one\n- two"} />);
		expect(container.querySelector("h1")?.textContent).toBe("Title");
		expect(container.querySelector("strong")?.textContent).toBe("bold");
		expect(container.querySelector("code")?.textContent).toBe("code");
		expect(container.querySelectorAll("li")).toHaveLength(2);
	});

	it("drops raw HTML: no script, no img with onerror", () => {
		const { container } = render(
			<Markdown text={'<script>alert(1)</script>\n\n<img src=x onerror="alert(2)">\n\nafter <b>raw</b>'} />,
		);
		expect(container.querySelector("script")).toBeNull();
		expect(container.querySelector("img")).toBeNull();
		expect(container.querySelector("b")).toBeNull();
		expect(container.innerHTML).not.toContain("onerror");
		expect(container.textContent).toContain("after");
	});

	it("never loads images; shows their alt text", () => {
		const { container } = render(<Markdown text="![a diagram](https://example.com/x.png)" />);
		expect(container.querySelector("img")).toBeNull();
		expect(container.textContent).toContain("a diagram");
	});

	it("drops javascript: links and opens others with noreferrer", () => {
		const { container } = render(<Markdown text="[bad](javascript:alert(1)) [good](https://example.com)" />);
		const links = [...container.querySelectorAll("a")];
		expect(links.some((a) => (a.getAttribute("href") ?? "").startsWith("javascript"))).toBe(false);
		const good = links.find((a) => a.textContent === "good");
		expect(good?.getAttribute("href")).toBe("https://example.com");
		expect(good?.getAttribute("rel")).toBe("noreferrer noopener");
		expect(good?.getAttribute("target")).toBe("_blank");
	});

	it("highlights matches inside inline code and code blocks too (final review I4)", () => {
		const { container } = render(
			<Markdown text={"Call `getCosts` here.\n\n```ts\nconst c = getCosts(db);\n```"} highlight="getcosts" />,
		);
		const marks = [...container.querySelectorAll("mark")];
		expect(marks.map((m) => m.textContent)).toEqual(["getCosts", "getCosts"]);
		expect(marks.every((m) => m.closest("code"))).toBe(true);
	});

	it("highlights matches of a find query in text, not in code fences' markup", () => {
		const { container } = render(<Markdown text={"Fix the **flaky** test, flaky again"} highlight="FLAKY" />);
		const marks = [...container.querySelectorAll("mark")];
		expect(marks.map((m) => m.textContent)).toEqual(["flaky", "flaky"]);
	});
});

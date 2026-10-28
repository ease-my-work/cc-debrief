// Markdown for replies, plans and memory files (Phase 7 spec decision 7): react-markdown without raw HTML (skipHtml),
// images shown as their alt text and never loaded, links with react-markdown's safe URL check and rel="noreferrer
// noopener". `highlight` wraps case-insensitive matches in <mark> (find in session), code spans and blocks included.
import type { ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";

type HastNode = {
	type: string;
	value?: string;
	tagName?: string;
	properties?: Record<string, unknown>;
	children?: HastNode[];
};

/**
 * A rehype plugin: split every text node (inside code too) around matches of `query` into
 * <mark data-find> elements. It runs on the HTML tree, after Markdown parsing, so markup characters never match.
 */
function markMatches(query: string) {
	const needle = query.toLowerCase();
	const walk = (node: HastNode) => {
		if (!node.children) return;
		const next: HastNode[] = [];
		for (const child of node.children) {
			if (child.type !== "text" || !child.value) {
				walk(child);
				next.push(child);
				continue;
			}
			const text = child.value;
			const lower = text.toLowerCase();
			let at = 0;
			for (let hit = lower.indexOf(needle); hit !== -1; hit = lower.indexOf(needle, at)) {
				if (hit > at) next.push({ type: "text", value: text.slice(at, hit) });
				next.push({
					type: "element",
					tagName: "mark",
					properties: { dataFind: "" },
					children: [{ type: "text", value: text.slice(hit, hit + needle.length) }],
				});
				at = hit + needle.length;
			}
			if (at < text.length) next.push({ type: "text", value: text.slice(at) });
		}
		node.children = next;
	};
	return () => (tree: HastNode) => walk(tree);
}

const components: Components = {
	img: ({ alt }) => <span className="text-muted">{alt ? `[image: ${alt}]` : "[image]"}</span>,
	a: ({ href, children }) =>
		href ? (
			<a href={href} target="_blank" rel="noreferrer noopener">
				{children}
			</a>
		) : (
			<span>{children}</span>
		),
};

export function Markdown({ text, highlight }: { text: string; highlight?: string }): ReactNode {
	const q = highlight?.trim() ?? "";
	return (
		<div className="markdown text-[13.5px] leading-relaxed break-words">
			<ReactMarkdown skipHtml components={components} rehypePlugins={q ? [markMatches(q)] : []}>
				{text}
			</ReactMarkdown>
		</div>
	);
}

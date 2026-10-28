// A tool chip in the timeline (feature 12): "Grep ×4 · 2.1s"; failures make it red ("… · failed ×3"); denials
// are listed ("… · denied ×1") but are not failures (feature 03).

type Tool = { label: string; count: number; totalMs: number | null; failures: number; denials: number };

/** 0.5s, 2.1s, 41s, 2m 5s */
export function seconds(ms: number): string {
	const s = ms / 1000;
	if (s < 10) return `${s.toFixed(1)}s`;
	if (s < 60) return `${Math.round(s)}s`;
	return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

export function chipText(t: Tool): string {
	const parts = [`${t.label}${t.count > 1 ? ` ×${t.count}` : ""}`];
	if (t.totalMs !== null) parts.push(seconds(t.totalMs));
	if (t.failures > 0) parts.push(`failed ×${t.failures}`);
	if (t.denials > 0) parts.push(`denied ×${t.denials}`);
	return parts.join(" · ");
}

export function ToolChip({ tool }: { tool: Tool }) {
	const failed = tool.failures > 0;
	return (
		<span
			data-failed={failed ? "true" : "false"}
			className={`mono inline-block rounded-md px-2 py-0.5 text-[12px] ${
				failed ? "bg-bad-fill text-bad" : "bg-neutral-fill text-neutral-text"
			}`}
		>
			{chipText(tool)}
		</span>
	);
}

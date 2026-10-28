import type { SessionType } from "@api-types";

const STYLE: Record<SessionType, string> = {
	feature: "b-feature",
	bugfix: "b-bugfix",
	refactor: "b-refactor",
	exploration: "b-exploration",
	ops: "b-ops",
	docs: "b-exploration",
	other: "b-exploration",
};

/** Session type badge; hidden while the type is unknown (Phase 2: no summaries yet). */
export function TypeBadge({ type, source }: { type: SessionType | null; source?: "ai" | "heuristic" | null }) {
	if (!type) return null;
	return (
		<span className={`badge ${STYLE[type]}`}>
			{type}
			{source === "heuristic" ? <span className="ml-1 opacity-70">heuristic</span> : null}
		</span>
	);
}

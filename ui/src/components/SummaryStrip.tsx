import type { InventoryResponse, Range } from "@api-types";
import { compactTokens, num } from "../lib/format";

const IN_RANGE: Record<Range, string> = {
	today: "at least once today",
	"7d": "at least once in 7 days",
	"30d": "at least once in 30 days",
	"90d": "at least once in 90 days",
	all: "at least once in the retained data",
};

function Card({ label, value, sub, warn = false }: { label: string; value: string; sub: string; warn?: boolean }) {
	return (
		<div className={`card flex flex-col gap-1.5 px-[18px] py-4 ${warn ? "border-amber" : ""}`}>
			<div className="section-h">{label}</div>
			<div className={`mono text-[26px] leading-none font-medium ${warn ? "text-amber" : ""}`}>{value}</div>
			<div className="text-[12.5px] text-muted">{sub}</div>
		</div>
	);
}

/** Installed · Invoked · Never invoked (amber) · Context cost (feature 12 summary strip). */
export function SummaryStrip({
	strip,
	noun,
	range,
	contextCost,
}: {
	strip: InventoryResponse["strip"];
	noun: [string, string];
	range: Range;
	contextCost: boolean;
}) {
	const s = strip;
	return (
		<div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
			<Card
				label="Installed"
				value={`${num(s.installed)} ${s.installed === 1 ? noun[0] : noun[1]}`}
				sub={`${num(s.byScope.user)} user · ${num(s.byScope.plugin)} plugin · ${num(s.byScope.repo)} in repos`}
			/>
			<Card label="Invoked" value={num(s.invoked)} sub={IN_RANGE[range]} />
			<Card label="Never invoked" value={num(s.neverInvoked)} sub="still loaded into every session" warn />
			<Card
				label="Context cost"
				value={contextCost ? `~${compactTokens(s.unusedCtxTokensPerSession)}` : "—"}
				sub={contextCost ? "tokens per session from unused skills" : "not measured for this kind"}
			/>
		</div>
	);
}

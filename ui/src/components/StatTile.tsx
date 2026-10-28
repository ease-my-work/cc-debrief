import type { ReactNode } from "react";

/** A stat tile: section label, big mono value, muted sub-line. */
export function StatTile({ label, value, sub }: { label: string; value: ReactNode; sub: ReactNode }) {
	return (
		<div className="card flex flex-col gap-1.5 px-[18px] py-4">
			<div className="section-h">{label}</div>
			<div className="mono text-[30px] leading-none font-medium">{value}</div>
			<div className="text-[12.5px] text-muted">{sub}</div>
		</div>
	);
}

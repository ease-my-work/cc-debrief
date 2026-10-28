import type { InventoryStatus } from "@api-types";

const LABEL: Record<InventoryStatus, string> = { active: "active", unused_30d: "unused 30d", never_used: "never used" };
const STYLE: Record<InventoryStatus, string> = {
	active: "bg-good-fill text-good",
	unused_30d: "bg-amber-fill text-amber",
	never_used: "bg-bad-fill text-bad",
};

/** Inventory status: active green, unused 30d amber, never used red (feature 12). */
export function StatusBadge({ status, removed = false }: { status: InventoryStatus; removed?: boolean }) {
	return (
		<span className="inline-flex items-center gap-1">
			<span className={`badge ${STYLE[status]}`} data-status={status}>
				{LABEL[status]}
			</span>
			{removed ? <span className="badge bg-neutral-fill text-neutral-text">removed</span> : null}
		</span>
	);
}

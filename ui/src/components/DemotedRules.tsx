// Settings "Demoted coaching rules" (features 09, 16): rules marked not helpful three times, with "Re-enable".
import type { ConfigResponse } from "@api-types";
import { ruleLabel } from "@rule-labels";
import { sendJson } from "../api";
import { num } from "../lib/format";

export function DemotedRules({ rules, onChanged }: { rules: ConfigResponse["demotedRules"]; onChanged: () => void }) {
	const enable = async (rule: string) => {
		try {
			await sendJson("POST", `/api/findings/rules/${encodeURIComponent(rule)}/enable`, {});
		} finally {
			onChanged();
		}
	};
	if (rules.length === 0)
		return (
			<div className="mt-0.5 text-[12.5px] text-muted">
				None. A rule you mark “not helpful” three times moves here, and you can re-enable it.
			</div>
		);
	return (
		<ul aria-label="Demoted coaching rules" className="m-0 mt-1 flex list-none flex-col gap-1 p-0 text-[13px]">
			{rules.map((r) => (
				<li key={r.rule} className="flex items-center gap-2.5">
					<span>
						{ruleLabel(r.rule)} · {num(r.notHelpful)} not helpful
					</span>
					<button
						type="button"
						onClick={() => enable(r.rule)}
						className="rounded-md border border-border bg-panel px-2 py-0.5 text-[12px] text-neutral-text"
					>
						Re-enable
					</button>
				</li>
			))}
		</ul>
	);
}

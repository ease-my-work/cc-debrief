import type { Range } from "@api-types";
import { LONG_LABEL, RANGES } from "../lib/ranges";

/** The "Last 30 days" dropdown of Skills & Tools and Repos. */
export function RangeSelect({ value, onChange }: { value: Range; onChange: (r: Range) => void }) {
	return (
		<select
			aria-label="Date range"
			value={value}
			onChange={(e) => onChange(e.target.value as Range)}
			className="rounded-lg border border-border bg-panel px-3 py-1.5 text-[13px] text-ink"
		>
			{RANGES.map((r) => (
				<option key={r} value={r}>
					{LONG_LABEL[r]}
				</option>
			))}
		</select>
	);
}

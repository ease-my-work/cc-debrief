// Settings "Monthly budget" (Phase 7 P4): dollars, saved on blur or Enter; blank turns the budget off.
import { useEffect, useRef, useState } from "react";

export function BudgetField({
	value,
	onCommit,
}: {
	value: number | null;
	onCommit: (next: number | null) => Promise<string | null>;
}) {
	const shown = value === null ? "" : String(value);
	const [draft, setDraft] = useState(shown);
	const [error, setError] = useState<string | null>(null);
	const input = useRef<HTMLInputElement>(null);
	// A reload that lands while the user is typing must not overwrite the draft.
	useEffect(() => {
		if (document.activeElement !== input.current) setDraft(shown);
	}, [shown]);

	const commit = async () => {
		const text = draft.trim().replace(/^\$/, "");
		if (text === shown) return;
		const n = Number(text);
		if (text !== "" && (!Number.isFinite(n) || n <= 0)) {
			setError("Enter dollars per month, or leave it blank for no budget.");
			setDraft(shown);
			return;
		}
		const message = await onCommit(text === "" ? null : n);
		setError(message);
		if (message) setDraft(shown);
	};

	return (
		<span className="inline-flex flex-col items-end gap-1">
			<span className="inline-flex items-center gap-1.5 text-[13px] text-muted">
				$
				<input
					ref={input}
					aria-label="Monthly budget (USD)"
					inputMode="decimal"
					placeholder="none"
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					onBlur={commit}
					onKeyDown={(e) => {
						if (e.key === "Enter") (e.target as HTMLInputElement).blur();
					}}
					className="mono w-[96px] rounded-md border border-border bg-panel px-2 py-1.5 text-right text-[13.5px] text-ink"
				/>
				a month
			</span>
			{error ? <span className="text-[12px] text-bad">{error}</span> : null}
		</span>
	);
}

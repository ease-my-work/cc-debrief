// A number input that saves on blur (or Enter). onCommit returns an error message to show under the field (the value
// goes back to the saved one), or null. scale converts the shown unit to the stored one (KB → bytes).
import { useEffect, useId, useState } from "react";

export function NumberField({
	label,
	value,
	onCommit,
	disabled = false,
	scale = 1,
	width = "w-[84px]",
	resetToken = 0,
}: {
	label: string;
	value: number;
	onCommit: (next: number) => Promise<string | null>;
	disabled?: boolean;
	scale?: number;
	width?: string;
	/** Bump to drop the typed value and show `value` again (a cancelled confirm step). */
	resetToken?: number;
}) {
	const shown = String(Math.round(value / scale));
	const [draft, setDraft] = useState(shown);
	const [error, setError] = useState<string | null>(null);
	const errorId = useId();
	// biome-ignore lint/correctness/useExhaustiveDependencies: resetToken is a trigger only
	useEffect(() => setDraft(shown), [shown, resetToken]);

	const commit = async () => {
		const n = Number(draft);
		if (draft.trim() === "" || !Number.isFinite(n) || String(Math.round(n)) === shown) {
			setDraft(shown);
			return;
		}
		const message = await onCommit(Math.round(n) * scale);
		setError(message);
		if (message) setDraft(shown);
	};

	return (
		<span className="inline-flex flex-col items-end gap-1">
			<input
				type="number"
				aria-label={label}
				aria-invalid={error ? true : undefined}
				aria-describedby={error ? errorId : undefined}
				value={draft}
				disabled={disabled}
				onChange={(e) => setDraft(e.target.value)}
				onBlur={commit}
				onKeyDown={(e) => {
					if (e.key === "Enter") (e.target as HTMLInputElement).blur();
				}}
				className={`mono ${width} rounded-md border bg-panel px-2 py-1.5 text-right text-[13.5px] text-ink disabled:bg-band disabled:text-muted ${error ? "border-bad" : "border-border"}`}
			/>
			{error ? (
				<span id={errorId} className="text-[12px] text-bad">
					{error}
				</span>
			) : null}
		</span>
	);
}

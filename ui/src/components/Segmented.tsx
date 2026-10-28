// A segmented control (Today / 7 days / 30 days); the active segment is a dark pill.
export function Segmented<T extends string>({
	options,
	value,
	onChange,
	label,
}: {
	options: { value: T; label: string }[];
	value: T;
	onChange: (v: T) => void;
	label: string;
}) {
	return (
		<fieldset
			aria-label={label}
			className="m-0 flex min-w-0 overflow-hidden rounded-lg border border-border bg-panel p-0 text-[13px]"
		>
			{options.map((o) => (
				<button
					key={o.value}
					type="button"
					aria-pressed={o.value === value}
					onClick={() => onChange(o.value)}
					className={
						o.value === value ? "bg-ink px-3 py-1.5 font-medium text-panel" : "px-3 py-1.5 text-muted hover:text-ink"
					}
				>
					{o.label}
				</button>
			))}
		</fieldset>
	);
}

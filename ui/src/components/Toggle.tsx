// An on/off switch (role="switch"): 36x20 track, as in Settings.html.
export function Toggle({
	checked,
	label,
	onChange,
	disabled = false,
}: {
	checked: boolean;
	label: string;
	onChange: (next: boolean) => void;
	disabled?: boolean;
}) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			aria-label={label}
			disabled={disabled}
			onClick={() => onChange(!checked)}
			className={`relative mt-px h-5 w-9 shrink-0 rounded-full border-0 p-0 transition-colors disabled:opacity-50 ${checked ? "bg-accent" : "bg-border"}`}
		>
			<span
				aria-hidden="true"
				className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${checked ? "left-[18px]" : "left-0.5"}`}
			/>
		</button>
	);
}

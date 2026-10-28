// First run and empty results (feature 12 "Empty, loading and error states").
export function EmptyState({
	title = "No sessions captured yet",
	hint = "Check the install with",
	command = "cc-debrief doctor",
}: {
	title?: string;
	hint?: string;
	command?: string | null;
}) {
	return (
		<div className="card flex flex-col items-center gap-2 px-6 py-12 text-center">
			<p className="m-0 text-[15px] font-semibold">{title}</p>
			{command ? (
				<p className="m-0 text-[13px] text-muted">
					{hint} <code className="mono rounded bg-neutral-fill px-1.5 py-0.5 text-ink">{command}</code>
				</p>
			) : (
				<p className="m-0 text-[13px] text-muted">{hint}</p>
			)}
		</div>
	);
}

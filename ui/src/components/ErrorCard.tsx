// An API failure inside one panel: the message and a retry; the rest of the page keeps working.
export function ErrorCard({ error, onRetry }: { error: Error; onRetry: () => void }) {
	return (
		<div role="alert" className="card flex items-center gap-3 border-bad px-4 py-3">
			<div className="flex-grow">
				<p className="m-0 text-[13px] font-semibold text-bad">Could not load this panel</p>
				<p className="m-0 text-[13px] text-muted">{error.message}</p>
			</div>
			<button
				type="button"
				onClick={onRetry}
				className="rounded-lg border border-border bg-panel px-3 py-1.5 text-[13px] text-ink hover:bg-background"
			>
				Retry
			</button>
		</div>
	);
}

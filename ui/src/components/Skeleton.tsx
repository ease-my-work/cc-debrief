// Loading placeholder at the final size of what it stands in for.
export function Skeleton({
	height = 16,
	width = "100%",
	className = "",
}: {
	height?: number;
	width?: number | string;
	className?: string;
}) {
	return (
		<div
			aria-hidden="true"
			className={`animate-pulse rounded-md bg-neutral-fill ${className}`}
			style={{ height, width }}
		/>
	);
}

export function SkeletonCard({ height = 120 }: { height?: number }) {
	return (
		<div className="card p-4" role="status" aria-busy="true" aria-label="Loading">
			<Skeleton height={12} width="40%" />
			<Skeleton height={height - 40} className="mt-4" />
		</div>
	);
}

import type { ReactNode } from "react";

/** View title with its controls on the right. */
export function TopBar({ title, children }: { title: string; children?: ReactNode }) {
	return (
		<div className="flex flex-wrap items-center gap-3">
			<h1 className="m-0 flex-grow text-[22px] font-semibold">{title}</h1>
			{children}
		</div>
	);
}

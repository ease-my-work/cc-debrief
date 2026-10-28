// Finding messages quote names in backticks (`a.ts`, `/compact`): render those parts monospaced.
import type { ReactNode } from "react";

export function richText(message: string): ReactNode[] {
	return message.split("`").map((part, i) =>
		i % 2 === 1 ? (
			// biome-ignore lint/suspicious/noArrayIndexKey: parts of one fixed string, never reordered
			<span key={i} className="mono">
				{part}
			</span>
		) : (
			part
		),
	);
}

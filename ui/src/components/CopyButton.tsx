// A copy-to-clipboard button: "Copied" for 2 s after a copy. `icon` makes it an icon-only button (aria-label only, no
// text), so it can sit inside the recap's <pre> without changing the text the card shows or copies.
import { useEffect, useState } from "react";

const COPIED_MS = 2000;

export function CopyButton({
	text,
	label,
	icon = false,
	className,
}: {
	text: string;
	label: string;
	icon?: boolean;
	className?: string;
}) {
	const [copied, setCopied] = useState(false);
	useEffect(() => {
		if (!copied) return;
		const t = setTimeout(() => setCopied(false), COPIED_MS);
		return () => clearTimeout(t);
	}, [copied]);
	const copy = async () => {
		try {
			await navigator.clipboard.writeText(text);
			setCopied(true);
		} catch {
			// Clipboard refused (insecure context or permission): nothing to show beyond the unchanged button.
		}
	};
	if (icon)
		return (
			<button
				type="button"
				aria-label={copied ? "Copied" : label}
				title={copied ? "Copied" : label}
				onClick={copy}
				className={`ml-1.5 inline-flex h-5 w-5 items-center justify-center rounded-[5px] border border-transparent bg-transparent p-0 align-[-3px] text-muted hover:border-border hover:text-ink ${className ?? ""}`}
			>
				<svg
					width="11"
					height="11"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2.2"
					strokeLinecap="round"
					aria-hidden="true"
				>
					{copied ? (
						<path d="M5 12l5 5 9-10" />
					) : (
						<>
							<rect x="9" y="9" width="11" height="11" rx="2" />
							<path d="M5 15V5a2 2 0 0 1 2-2h8" />
						</>
					)}
				</svg>
			</button>
		);
	return (
		<button
			type="button"
			onClick={copy}
			className={`rounded-[7px] border border-border bg-panel px-2.5 py-1 text-[12.5px] text-neutral-text hover:text-ink ${className ?? ""}`}
		>
			{copied ? "Copied" : label}
		</button>
	);
}

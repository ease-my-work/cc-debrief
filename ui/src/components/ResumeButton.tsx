import { useState } from "react";

/** Copies `claude --resume <id>`; a browser cannot open a terminal (feature 12). */
export function ResumeButton({ command }: { command: string }) {
	const [copied, setCopied] = useState(false);
	const copy = async () => {
		try {
			await navigator.clipboard.writeText(command);
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		} catch {
			setCopied(false);
		}
	};
	return (
		<span className="inline-flex items-center gap-2">
			<button
				type="button"
				title={command}
				onClick={copy}
				className="cursor-pointer border-0 bg-transparent p-0 text-[12.5px] font-medium text-accent"
			>
				claude --resume
			</button>
			{copied ? <span className="text-[12px] text-good">Copied</span> : null}
		</span>
	);
}

// "Remove" (feature 12): says how to remove the item and shows its path with a copy button. Nothing is deleted, no
// request is sent and no process is started; the developer removes it themselves.
import { useEffect, useRef, useState } from "react";

export type RemoveTarget = {
	name: string;
	path: string;
	kind: "skill" | "mcp";
	scope: "user" | "plugin" | "repo";
	source: string; // the plugin name for plugin items
};

/** What to do, per kind: a skill is its own folder; an MCP server is one entry inside a shared config file. */
export function removeAdvice(t: RemoveTarget): string {
	if (t.scope === "plugin") {
		return `Provided by the ${t.source} plugin: disable or uninstall the plugin in Claude Code to stop loading it. Files in a plugin's folder are replaced when it updates.`;
	}
	if (t.kind === "mcp") {
		return `Remove the "${t.name}" entry from this file. The file holds other settings too, so edit it; do not delete it.`;
	}
	return "Delete this folder to stop loading the skill.";
}

export function RemovePopover({ target }: { target: RemoveTarget }) {
	const [open, setOpen] = useState(false);
	const [copied, setCopied] = useState(false);
	const box = useRef<HTMLSpanElement>(null);

	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
		const onClick = (e: MouseEvent) => {
			if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
		};
		document.addEventListener("keydown", onKey);
		document.addEventListener("mousedown", onClick);
		return () => {
			document.removeEventListener("keydown", onKey);
			document.removeEventListener("mousedown", onClick);
		};
	}, [open]);

	return (
		<span ref={box} className="relative inline-block">
			<button
				type="button"
				onClick={() => {
					setOpen(!open);
					setCopied(false);
				}}
				className="border-0 bg-transparent p-0 text-[12.5px] font-medium text-accent"
			>
				Remove
			</button>
			{open ? (
				<div
					role="dialog"
					aria-label={`Remove ${target.name}`}
					className="card absolute right-0 z-10 mt-1 flex w-[380px] flex-col gap-2 p-3 text-left shadow-lg"
				>
					<p className="m-0 text-[12.5px] text-ink">{removeAdvice(target)}</p>
					<code className="mono rounded bg-neutral-fill px-2 py-1 text-[12px] break-all text-ink">{target.path}</code>
					<p className="m-0 text-[12px] text-muted">cc-debrief never deletes or changes files.</p>
					<div className="flex items-center gap-2">
						<button
							type="button"
							onClick={async () => {
								try {
									await navigator.clipboard.writeText(target.path);
									setCopied(true);
								} catch {
									setCopied(false);
								}
							}}
							className="rounded-md border border-border bg-panel px-2.5 py-1 text-[12.5px] text-ink"
						>
							Copy path
						</button>
						{copied ? <span className="text-[12px] text-good">Copied</span> : null}
					</div>
				</div>
			) : null}
		</span>
	);
}

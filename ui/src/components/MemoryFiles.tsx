// The repo's Claude Code auto-memory files (Phase 7 P12): listed by name, size and date; one opens read-only as
// Markdown, cut at 64 KB. Read live from ~/.claude/projects/<slug>/memory; nothing is stored or edited.
import type { MemoryFileResponse, MemoryListResponse } from "@api-types";
import { useState } from "react";
import { relTime } from "../lib/format";
import { useApi } from "../lib/useApi";
import { ErrorCard } from "./ErrorCard";
import { Markdown } from "./Markdown";

const kb = (bytes: number) => (bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`);

export function MemoryFiles({ repoId }: { repoId: string }) {
	const base = `/api/repos/${encodeURIComponent(repoId)}/memory`;
	const list = useApi<MemoryListResponse>(base);
	const [open, setOpen] = useState<string | null>(null);
	const file = useApi<MemoryFileResponse>(open ? `${base}/${encodeURIComponent(open)}` : null);
	const files = list.data?.files ?? [];
	return (
		<section aria-label="Memory files" className="card flex flex-col gap-2 px-[18px] py-4">
			<div className="section-h">Memory files</div>
			{list.error ? <ErrorCard error={list.error} onRetry={list.reload} /> : null}
			{list.data && files.length === 0 ? (
				<p className="m-0 text-[12.5px] text-muted">Claude Code has no auto-memory for this repo.</p>
			) : null}
			<ul className="m-0 flex list-none flex-col gap-1 p-0 text-[12.5px]">
				{files.map((f) => (
					<li key={f.name} className="flex items-center gap-2">
						<button
							type="button"
							aria-pressed={open === f.name}
							onClick={() => setOpen(open === f.name ? null : f.name)}
							className={`mono min-w-0 flex-grow truncate border-0 bg-transparent p-0 text-left ${open === f.name ? "font-semibold text-ink" : "text-accent"}`}
						>
							{f.name}
						</button>
						<span className="text-muted">
							{kb(f.size)} · {relTime(f.mtime)}
						</span>
					</li>
				))}
			</ul>
			{open && file.data ? (
				<div className="mt-1 rounded-lg border border-border bg-band px-3 py-2.5">
					<Markdown text={file.data.text} />
					{file.data.truncated ? <div className="mt-1 text-[12px] text-muted">cut at 64 KB</div> : null}
				</div>
			) : null}
			{open && file.error ? <ErrorCard error={file.error} onRetry={file.reload} /> : null}
		</section>
	);
}

// "Add to CLAUDE.md" preview (feature 11 UI): the exact text from the draft and the exact file it goes to, before the
// click that writes it (POST /api/patterns/:id/install); then the paths written.
import type { DraftFile, InstallResponse } from "@api-types";
import { useEffect, useState } from "react";
import { ApiErrorClass, getJson, sendJson } from "../api";

export function ClaudeMdPreview({
	patternId,
	onDone,
	onCancel,
}: {
	patternId: number;
	onDone: () => void;
	onCancel: () => void;
}) {
	const [draft, setDraft] = useState<DraftFile | null>(null);
	const [written, setWritten] = useState<string[] | null>(null);
	const [note, setNote] = useState<string | null>(null);
	useEffect(() => {
		let live = true;
		getJson<DraftFile>(`/api/patterns/${patternId}/draft`)
			.then((f) => live && setDraft(f))
			.catch((e) => live && setNote(e instanceof ApiErrorClass ? e.message : String(e)));
		return () => {
			live = false;
		};
	}, [patternId]);
	const install = async () => {
		setNote(null);
		try {
			const r = await sendJson<InstallResponse>("POST", `/api/patterns/${patternId}/install`);
			setWritten(r.written);
			onDone();
		} catch (e) {
			setNote(e instanceof ApiErrorClass ? e.message : String(e));
		}
	};
	if (written) {
		return (
			<div role="status" className="text-[12px] text-muted">
				Written: <span className="mono">{written.join(", ")}</span>
			</div>
		);
	}
	const append = draft?.target?.replace(/\\/g, "/").endsWith("/CLAUDE.md") ?? true;
	return (
		<fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0" aria-label="CLAUDE.md preview">
			<div className="text-[12px] text-muted">
				{append ? "Appends after a blank line to " : "Creates "}
				<span className="mono">{draft?.target ?? "…"}</span>:
			</div>
			<pre className="mono m-0 rounded-md border border-row bg-panel px-2.5 py-1.5 text-[12.5px] whitespace-pre-wrap">
				{draft?.content ?? "…"}
			</pre>
			<div className="flex items-center gap-2">
				<button
					type="button"
					onClick={install}
					disabled={!draft?.target}
					className="rounded-md border-0 bg-ink px-2.5 py-1 text-[12px] font-medium text-panel disabled:opacity-60"
				>
					{append ? "Append" : "Create"}
				</button>
				<button
					type="button"
					onClick={onCancel}
					className="rounded-md border border-border bg-panel px-2.5 py-1 text-[12px] text-neutral-text"
				>
					Cancel
				</button>
				{note ? <span className="text-[12px] text-muted">{note}</span> : null}
			</div>
		</fieldset>
	);
}

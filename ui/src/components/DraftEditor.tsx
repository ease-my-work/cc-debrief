// The draft editor (feature 11 "Draft flow" step 6): the full SKILL.md (or RULE.md) in a textarea; Save calls
// PUT /api/patterns/:id/draft, which validates the front matter and rewrites the draft file only.
import type { DraftFile } from "@api-types";
import { useEffect, useState } from "react";
import { ApiErrorClass, getJson, sendJson } from "../api";

export function DraftEditor({ patternId, onClose }: { patternId: number; onClose: () => void }) {
	const [file, setFile] = useState<DraftFile | null>(null);
	const [content, setContent] = useState("");
	const [note, setNote] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	useEffect(() => {
		let live = true;
		getJson<DraftFile>(`/api/patterns/${patternId}/draft`)
			.then((f) => {
				if (!live) return;
				setFile(f);
				setContent(f.content);
			})
			.catch((e) => live && setNote(e instanceof ApiErrorClass ? e.message : String(e)));
		return () => {
			live = false;
		};
	}, [patternId]);
	const save = async () => {
		setSaving(true);
		setNote(null);
		try {
			await sendJson("PUT", `/api/patterns/${patternId}/draft`, { content });
			setNote("Saved");
		} catch (e) {
			setNote(e instanceof ApiErrorClass ? e.message : String(e));
		} finally {
			setSaving(false);
		}
	};
	return (
		<fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0" aria-label="Draft editor">
			{file ? <div className="mono truncate text-[11.5px] text-muted">{file.path}</div> : null}
			<textarea
				aria-label="Draft content"
				value={content}
				onChange={(e) => setContent(e.target.value)}
				spellCheck={false}
				className="mono min-h-[220px] w-full rounded-md border border-border bg-panel p-2 text-[12.5px] text-ink"
			/>
			<div className="flex items-center gap-2">
				<button
					type="button"
					onClick={save}
					disabled={saving || !file}
					className="rounded-md border-0 bg-ink px-2.5 py-1 text-[12px] font-medium text-panel disabled:opacity-60"
				>
					{saving ? "Saving…" : "Save"}
				</button>
				<button
					type="button"
					onClick={onClose}
					className="rounded-md border border-border bg-panel px-2.5 py-1 text-[12px] text-neutral-text"
				>
					Close
				</button>
				{note ? (
					<span role="status" className="text-[12px] text-muted">
						{note}
					</span>
				) : null}
			</div>
		</fieldset>
	);
}

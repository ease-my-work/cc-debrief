// Settings "Recap" multi-select for recap.hiddenRepos (feature 16, 17): one checkbox per known repo, plus any hidden
// name that matches no repo yet (kept so it can be unchecked). Matching is case-insensitive on name or id, as in the
// recap itself; a toggle saves the whole list.
import type { ReposResponse } from "@api-types";
import { useState } from "react";
import { useApi } from "../lib/useApi";

export function HiddenReposField({
	hidden,
	onSave,
}: {
	hidden: string[];
	onSave: (next: string[]) => Promise<string | null>;
}) {
	const { data } = useApi<ReposResponse>("/api/repos");
	const [note, setNote] = useState<string | null>(null);
	const lower = (s: string) => s.toLowerCase();
	const known = [...new Map((data?.repos ?? []).map((r) => [lower(r.name), r])).values()];
	const matches = (entry: string, r: { name: string; id: string }) =>
		lower(entry) === lower(r.name) || lower(entry) === lower(r.id);
	const orphans = hidden.filter((h) => !known.some((r) => matches(h, r)));
	const options = [
		...known.map((r) => ({ label: r.name, checked: hidden.some((h) => matches(h, r)), repo: r })),
		...orphans.map((h) => ({ label: h, checked: true, repo: null })),
	].sort((a, b) => a.label.localeCompare(b.label));

	const toggle = async (o: (typeof options)[number], on: boolean) => {
		const next = on
			? [...hidden, o.label]
			: hidden.filter((h) => (o.repo ? !matches(h, o.repo) : lower(h) !== lower(o.label)));
		setNote(await onSave(next));
	};

	if (options.length === 0) return <div className="text-[12.5px] text-muted">No repos recorded yet.</div>;
	return (
		<div className="flex flex-col gap-1.5">
			<div className="flex flex-wrap gap-x-4 gap-y-1.5">
				{options.map((o) => (
					<label key={o.label} className="mono inline-flex items-center gap-1.5 text-[12.5px] text-ink">
						<input type="checkbox" checked={o.checked} onChange={(e) => void toggle(o, e.target.checked)} />
						{o.label}
					</label>
				))}
			</div>
			{note ? <div className="text-[12px] text-bad">{note}</div> : null}
		</div>
	);
}

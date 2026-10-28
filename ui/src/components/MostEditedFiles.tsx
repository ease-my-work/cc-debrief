import type { RepoDetail } from "@api-types";
import { num } from "../lib/format";

/** "<repo> · most edited files": top 5 with "14 sessions · +410"; the session-type footer waits for Phase 3. */
export function MostEditedFiles({ d }: { d: RepoDetail }) {
	return (
		<div className="card flex flex-col gap-1 px-[18px] py-4">
			<div className="section-h mb-1.5">{d.repo.name} · most edited files</div>
			{d.files.length === 0 ? <p className="m-0 text-[13px] text-muted">No file changes in this range.</p> : null}
			{d.files.map((f) => (
				<div key={f.path} className="flex justify-between gap-3 py-1 text-[13px]">
					<span className="mono truncate" title={f.path}>
						{f.path}
					</span>
					<span className="mono shrink-0 text-muted">{`${num(f.sessions)} sessions · +${num(f.added)}`}</span>
				</div>
			))}
			{d.typeMix.length > 0 ? (
				<div className="mt-2 text-[12px] text-muted">
					Session types here: {d.typeMix.map((t) => `${t.pct}% ${t.type}`).join(" · ")}
				</div>
			) : null}
		</div>
	);
}

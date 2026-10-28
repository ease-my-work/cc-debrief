// Skills & Tools "Skills proposed from repeated work" (feature 11 UI; mockup SkillsTools.html): name and description,
// repo, status badge ("installed 12d", "candidate", amber "installed 16d · 0 invoked"), invoked count, median tokens and
// duration before → after, and the action (Draft (~$), Widen description (~$), Review).
import type { DraftResponse, ProposedSkill } from "@api-types";
import { useState } from "react";
import { Link } from "wouter";
import { ApiErrorClass, sendJson } from "../api";
import { compactTokens, duration, num, usd } from "../lib/format";

function statusBadge(s: ProposedSkill) {
	if (s.status === "installed") {
		const days = `installed ${s.installedDays ?? 0}d`;
		if (s.invoked === 0 && (s.installedDays ?? 0) >= 14) {
			return <span className="badge bg-amber-fill text-amber">{days} · 0 invoked</span>;
		}
		return (
			<span className="inline-flex items-center gap-1">
				<span className="badge bg-good-fill text-good">{days}</span>
				{s.removed ? <span className="badge bg-neutral-fill text-neutral-text">removed</span> : null}
			</span>
		);
	}
	return (
		<span className="badge bg-neutral-fill text-neutral-text">{s.status === "drafted" ? "drafted" : "candidate"}</span>
	);
}

function tokensCell(s: ProposedSkill) {
	const m = s.medianTokens;
	if (s.status === "installed" && s.invoked === 0 && (s.sessionsSinceInstall ?? 0) > 0 && !m?.after) {
		return (
			<>
				<span className="mono text-[12.5px]">—</span>{" "}
				<span className="text-[12px] text-amber">pattern recurred {s.sessionsSinceInstall}× since</span>
			</>
		);
	}
	if (!m) return <span className="mono text-[12.5px]">—</span>;
	if (m.after !== null) {
		return (
			<>
				<span className="mono text-[12.5px]">
					{compactTokens(m.before)} → {compactTokens(m.after)}
				</span>{" "}
				{m.pct !== null ? (
					<span className={`text-[12px] ${m.pct <= 0 ? "text-good" : "text-bad"}`}>
						{m.pct > 0 ? "+" : "−"}
						{Math.abs(m.pct)}%
					</span>
				) : null}
			</>
		);
	}
	return (
		<>
			<span className="mono text-[12.5px]">{compactTokens(m.before)}</span>{" "}
			<span className="text-[12px] text-muted">
				{s.status === "installed" ? "before install" : `${s.sessionCount} sessions`}
			</span>
		</>
	);
}

function durationCell(s: ProposedSkill) {
	const d = s.medianDurationSec;
	if (!d) return <span className="mono text-[12.5px]">—</span>;
	return (
		<span className="mono text-[12.5px]">
			{d.after !== null ? `${duration(d.before)} → ${duration(d.after)}` : duration(d.before)}
		</span>
	);
}

function Action({ s, onChanged }: { s: ProposedSkill; onChanged: () => void }) {
	const [busy, setBusy] = useState(false);
	const [note, setNote] = useState<string | null>(null);
	const est = s.estUsd === null ? "cost unknown" : `~${usd(s.estUsd)}`;
	const draft = async (mode: "create" | "widen") => {
		setBusy(true);
		setNote(null);
		try {
			const r = await sendJson<DraftResponse>("POST", `/api/patterns/${s.patternId}/draft`, { mode });
			setNote(`cost ${usd(r.costUsd)}`);
			onChanged();
		} catch (e) {
			setNote(e instanceof ApiErrorClass ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};
	const link = "border-0 bg-transparent p-0 text-[12.5px] text-accent disabled:opacity-60";
	return (
		<span className="inline-flex items-center gap-2">
			{s.action === "draft" ? (
				<button type="button" className={link} disabled={busy} onClick={() => draft("create")}>
					{busy ? "Drafting…" : `Draft (${est})`}
				</button>
			) : null}
			{s.action === "widen" ? (
				<button type="button" className={link} disabled={busy} onClick={() => draft("widen")}>
					{busy ? "Drafting…" : `Widen description (${est})`}
				</button>
			) : null}
			{s.action === "review" && s.repo ? (
				<Link href={`/repos/${encodeURIComponent(s.repo.id)}`} className="text-[12.5px] no-underline">
					Review draft
				</Link>
			) : null}
			{note ? <span className="text-[12px] text-muted">{note}</span> : null}
		</span>
	);
}

export function ProposedSkillsTable({ rows, onChanged }: { rows: ProposedSkill[]; onChanged: () => void }) {
	return (
		<section className="card overflow-hidden" aria-label="Skills proposed from repeated work">
			<div className="flex items-center gap-3 px-4 pt-3.5 pb-1.5">
				<div className="section-h flex-grow">Skills proposed from repeated work</div>
				<span className="text-[12px] text-muted">benefit = sessions matching the pattern, before vs after install</span>
			</div>
			<div className="overflow-x-auto">
				<table className="data-table">
					<thead>
						<tr>
							<th>Proposed skill</th>
							<th>Repo</th>
							<th>Status</th>
							<th className="num">Invoked</th>
							<th>Median tokens / session</th>
							<th>Median duration</th>
							<th />
						</tr>
					</thead>
					<tbody>
						{rows.map((s) => (
							<tr key={s.patternId}>
								<td>
									<span className="mono">{s.name}</span>
									{s.description ? <div className="text-[12px] text-muted">{s.description}</div> : null}
								</td>
								<td className="mono text-[12.5px]">{s.repo?.name ?? "user"}</td>
								<td>{statusBadge(s)}</td>
								<td className="num">{s.invoked === null ? "—" : num(s.invoked)}</td>
								<td>{tokensCell(s)}</td>
								<td>{durationCell(s)}</td>
								<td>
									<Action s={s} onChanged={onChanged} />
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</section>
	);
}

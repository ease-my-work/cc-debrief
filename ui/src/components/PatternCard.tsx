// One "Repeated work · suggestions" card (features 10, 11 UI; mockup Repos.html): the kind badge and label, a muted
// facts line, and the buttons for its state: Draft skill (~$) / Enable skill drafts in Settings, Review draft and
// Install to repo (with a confirm naming the exact file), Add to CLAUDE.md (with a preview), Rewrite with Claude
// (~$), Dismiss. A test gap is one line.
import type { DraftFile, DraftResponse, InstallResponse, PatternRow } from "@api-types";
import { useState } from "react";
import { Link } from "wouter";
import { ApiErrorClass, getJson, sendJson } from "../api";
import { compactTokens, usd } from "../lib/format";
import { ClaudeMdPreview } from "./ClaudeMdPreview";
import { DraftEditor } from "./DraftEditor";

const KIND: Record<PatternRow["kind"], { label: string; className: string }> = {
	repo_skill: { label: "repo skill", className: "bg-accent-fill text-accent" },
	user_skill: { label: "user skill", className: "bg-accent-fill text-accent" },
	claude_md_rule: { label: "CLAUDE.md rule", className: "bg-neutral-fill text-neutral-text" },
	claude_md_pointer: { label: "CLAUDE.md pointer", className: "bg-neutral-fill text-neutral-text" },
	test_gap: { label: "test gap", className: "bg-bad-fill text-bad" },
};

const PRIMARY = "rounded-md border-0 bg-ink px-2.5 py-1 text-[12px] font-medium text-panel disabled:opacity-60";
const SECONDARY =
	"rounded-md border border-border bg-panel px-2.5 py-1 text-[12px] text-neutral-text disabled:opacity-60";

/** "drafts/billing-api/alembic-column/" from an absolute draft path. */
export function draftDirText(path: string): string {
	const parts = path.split(/[\\/]/);
	const at = parts.lastIndexOf("drafts");
	return at >= 0 ? `${parts.slice(at, -1).join("/")}/` : path;
}

const sessions = (n: number) => `${n} ${n === 1 ? "session" : "sessions"}`;

function facts(p: PatternRow): string {
	if (p.kind === "claude_md_rule") {
		return `Corrected by you in ${sessions(p.correctionCount ?? p.sessionCount)} · ≈ ${compactTokens(p.tokensTotal)} tokens`;
	}
	if (p.kind === "claude_md_pointer")
		return `Read at the start of ${sessions(p.sessionCount)}: ${(p.readFiles ?? []).join(", ")}`;
	if (p.status === "drafted" && p.draftPath) {
		return `${sessions(p.sessionCount)} · ≈ ${compactTokens(p.tokensTotal)} tokens · draft ready in ${draftDirText(p.draftPath)}`;
	}
	if (p.status === "installed")
		return `installed · ${sessions(p.sessionCount)} · ≈ ${compactTokens(p.tokensTotal)} tokens`;
	return `${sessions(p.sessionCount)} in 30 days · ≈ ${compactTokens(p.tokensTotal)} tokens`;
}

export function PatternCard({
	p,
	draftsEnabled,
	onChanged,
}: {
	p: PatternRow;
	draftsEnabled: boolean;
	onChanged: () => void;
}) {
	const [busy, setBusy] = useState(false);
	const [note, setNote] = useState<string | null>(p.error);
	const [panel, setPanel] = useState<"editor" | "preview" | "confirm" | null>(null);
	const [target, setTarget] = useState<string | null>(null);
	const [written, setWritten] = useState<string[] | null>(null);
	const kind = KIND[p.kind];

	const run = async <T,>(fn: () => Promise<T>): Promise<T | null> => {
		setBusy(true);
		setNote(null);
		try {
			return await fn();
		} catch (e) {
			setNote(e instanceof ApiErrorClass ? e.message : String(e));
			return null;
		} finally {
			setBusy(false);
		}
	};
	const draft = (mode: "create" | "rewrite_rule") =>
		run(async () => {
			const r = await sendJson<DraftResponse>("POST", `/api/patterns/${p.id}/draft`, { mode });
			setNote(`Drafted · cost ${usd(r.costUsd)}`);
			onChanged();
			if (mode === "rewrite_rule") setPanel("preview");
		});
	const addToClaudeMd = () =>
		run(async () => {
			if (p.status !== "drafted") await sendJson("POST", `/api/patterns/${p.id}/draft-rule`);
			setPanel("preview");
		});
	const confirmInstall = () =>
		run(async () => {
			const f = await getJson<DraftFile>(`/api/patterns/${p.id}/draft`);
			setTarget(f.target);
			setPanel("confirm");
		});
	const install = () =>
		run(async () => {
			const r = await sendJson<InstallResponse>("POST", `/api/patterns/${p.id}/install`);
			setWritten(r.written);
			setPanel(null);
			onChanged();
		});
	const dismiss = () =>
		run(async () => {
			await sendJson("POST", `/api/patterns/${p.id}/dismiss`);
			onChanged();
		});

	if (p.kind === "test_gap") {
		return (
			<div className="flex items-start gap-2 px-0.5 py-1 text-[12.5px] leading-[1.45]">
				<span className={`badge shrink-0 ${kind.className}`}>{kind.label}</span>
				<span>
					<span className="mono">{p.testGapPath ?? p.label}</span> fixed in {p.sessionCount} separate bugfix sessions —
					no test covers it
				</span>
			</div>
		);
	}

	const isRule = p.kind === "claude_md_rule" || p.kind === "claude_md_pointer";
	const est = p.estDraftUsd === null ? "cost unknown" : `~${usd(p.estDraftUsd)}`;
	return (
		<article className="flex flex-col gap-1.5 rounded-lg border border-border px-3 py-2.5" aria-label={p.label}>
			<div className="flex items-center gap-2">
				<span className={`badge ${kind.className}`}>{kind.label}</span>
				<span className="flex-grow text-[13px] font-semibold">
					{p.kind === "claude_md_rule" ? `"${p.label}"` : p.label}
				</span>
				{p.status === "drafted" ? <span className="badge bg-good-fill text-good">drafted</span> : null}
				{p.status === "installed" ? <span className="badge bg-good-fill text-good">installed</span> : null}
			</div>
			<div className="text-[12px] leading-[1.45] text-muted">
				{facts(p)}
				{p.fingerprint && p.status === "candidate" && !isRule ? (
					<>
						{" · "}
						<span className="mono">{p.fingerprint}</span>
					</>
				) : null}
			</div>
			{p.status !== "installed" ? (
				<div className="flex flex-wrap items-center gap-2">
					{isRule ? (
						<>
							<button type="button" className={PRIMARY} disabled={busy} onClick={addToClaudeMd}>
								Add to CLAUDE.md
							</button>
							{p.kind === "claude_md_rule" && draftsEnabled ? (
								<button type="button" className={SECONDARY} disabled={busy} onClick={() => draft("rewrite_rule")}>
									Rewrite with Claude ({est})
								</button>
							) : null}
						</>
					) : p.status === "drafted" ? (
						<>
							<button type="button" className={PRIMARY} onClick={() => setPanel(panel === "editor" ? null : "editor")}>
								Review draft
							</button>
							<button type="button" className={SECONDARY} disabled={busy} onClick={confirmInstall}>
								{p.kind === "user_skill" ? "Install for me" : "Install to repo"}
							</button>
						</>
					) : draftsEnabled ? (
						<button type="button" className={PRIMARY} disabled={busy} onClick={() => draft("create")}>
							{busy ? "Drafting… up to 3 min" : `Draft skill (${est})`}
						</button>
					) : (
						<Link href="/settings#drafts" className="text-[12.5px] font-medium no-underline">
							Enable skill drafts in Settings
						</Link>
					)}
					<button type="button" className={SECONDARY} disabled={busy} onClick={dismiss}>
						Dismiss
					</button>
				</div>
			) : null}
			{panel === "editor" ? <DraftEditor patternId={p.id} onClose={() => setPanel(null)} /> : null}
			{panel === "preview" ? (
				<ClaudeMdPreview patternId={p.id} onDone={onChanged} onCancel={() => setPanel(null)} />
			) : null}
			{panel === "confirm" ? (
				<fieldset
					className="m-0 flex min-w-0 flex-wrap items-center gap-2 border-0 p-0 text-[12px]"
					aria-label="Install confirm"
				>
					<span className="text-muted">
						Writes <span className="mono">{target ?? "(target unknown)"}</span>
					</span>
					<button type="button" className={PRIMARY} disabled={busy || !target} onClick={install}>
						Install
					</button>
					<button type="button" className={SECONDARY} onClick={() => setPanel(null)}>
						Cancel
					</button>
				</fieldset>
			) : null}
			{written ? (
				<div role="status" className="text-[12px] text-muted">
					Written: <span className="mono">{written.join(", ")}</span>
				</div>
			) : null}
			{note ? (
				<div role="status" className="text-[12px] text-muted">
					{note}
				</div>
			) : null}
		</article>
	);
}

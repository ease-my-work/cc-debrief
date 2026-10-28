// The recap card (feature 17 UI). Repo headings
// with a dotted leader, a ×N session count and a copy button; one item per bullet with a dot (orange: described by a
// title, summary or agent name; grey: files edited or read), its text linking to the session, and its start time on
// the right; an END OF DAY footer with an activity strip. Times are view only: "Copy text" copies the server's plain
// text. Polish is one POST; its result lives only in this card's state.
import type { PolishedRecap, RecapBullet, RecapGroup, RecapPolishResponse, RecapResponse } from "@api-types";
import { useState } from "react";
import { Link } from "wouter";
import { ApiErrorClass, sendJson } from "../api";
import { usd } from "../lib/format";
import { ActivityStrip } from "./ActivityStrip";
import { CopyButton } from "./CopyButton";

const SOURCE: Record<RecapBullet["source"], string> = {
	title: "from session title",
	summary: "from AI summary",
	agent_name: "from agent name",
	files: "from edited files",
	explored: "from files read",
};
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");

/** "Mon, Sep 28 2026", as the server's formatter writes it. */
function dayLabel(date: string): string {
	const [y, m, d] = date.split("-").map(Number);
	return `${DAYS[new Date(y, m - 1, d).getDay()]}, ${MONTHS[m - 1]} ${d} ${y}`;
}
function rangeLabel(from: string, to: string): string {
	if (from === to) return dayLabel(from);
	const a = dayLabel(from);
	const b = dayLabel(to);
	return from.slice(0, 4) === to.slice(0, 4) ? `${a.slice(0, -5)} – ${b}` : `${a} – ${b}`;
}
const localDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** 09:14, or "Tue 09:14" when the list spans days. */
function timeOf(iso: string, withDay: boolean): string {
	const d = new Date(iso);
	const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
	return withDay ? `${DAYS[d.getDay()]} ${hm}` : hm;
}
/** An actual polish cost: three decimals under 10 cents ("$0.012"), else dollars and cents. */
const cost = (v: number | null) => (v === null ? "cost unknown" : v < 0.1 ? `$${v.toFixed(3)}` : usd(v));
const plural = (n: number, w: string) => `${n} ${n === 1 ? w : `${w}s`}`;
const described = (s: RecapBullet["source"]) => s === "title" || s === "summary" || s === "agent_name";

function Dot({ warm }: { warm: boolean }) {
	return (
		<span
			aria-hidden="true"
			className={`mt-[7px] inline-block h-[7px] w-[7px] shrink-0 rounded-full ${warm ? "bg-warm" : "bg-muted opacity-60"}`}
		/>
	);
}

function RepoHeading({ repo, sessions, copy }: { repo: string; sessions: number; copy: string | undefined }) {
	return (
		<div className="flex items-center gap-1.5 pt-3 pb-1">
			<h4 className="m-0 flex min-w-0 flex-grow items-center gap-2 text-[13px] font-semibold">
				<span className="mono truncate">{repo}</span>
				<span aria-hidden="true" className="h-0 flex-grow border-b border-dotted border-muted opacity-50" />
				{sessions > 1 ? <span className="mono text-[12px] font-normal text-muted">×{sessions}</span> : null}
			</h4>
			{copy ? <CopyButton icon text={copy} label={`Copy ${repo}`} /> : null}
		</div>
	);
}

function Group({
	group,
	copy,
	withDay,
	onBullet,
}: {
	group: RecapGroup;
	copy: string | undefined;
	withDay: boolean;
	onBullet: (b: RecapBullet) => void;
}) {
	const sessions = new Set(group.bullets.flatMap((b) => b.sessionIds)).size;
	return (
		<div>
			<RepoHeading repo={group.repo} sessions={sessions} copy={copy} />
			<ul className="m-0 flex list-none flex-col gap-1 p-0">
				{group.bullets.map((b) => {
					const warm = described(b.source);
					return (
						<li
							key={`${b.sessionIds[0]}-${b.text}`}
							data-kind={warm ? "described" : "work"}
							className="mono flex items-start gap-2 text-[13px] leading-[1.5]"
						>
							<Dot warm={warm} />
							<div className="min-w-0 flex-grow">
								<Link
									href={`/sessions/${encodeURIComponent(b.sessionIds[0])}`}
									onMouseEnter={() => onBullet(b)}
									onFocus={() => onBullet(b)}
									className={`no-underline hover:bg-accent-fill ${warm ? "text-ink" : "text-muted"} hover:text-ink`}
								>
									{b.text}
								</Link>
								{b.files.length ? (
									<div className="text-[12px] text-muted">
										{b.files.join(", ")}
										{b.moreFiles > 0 ? ` +${b.moreFiles}` : ""}
									</div>
								) : null}
							</div>
							<span className="shrink-0 text-[12px] text-muted tabular-nums">{timeOf(b.firstTurnAt, withDay)}</span>
						</li>
					);
				})}
			</ul>
		</div>
	);
}

function Polished({ polished }: { polished: PolishedRecap }) {
	return (
		<>
			{polished.groups.map((g) => (
				<div key={g.repo}>
					<RepoHeading repo={g.repo} sessions={0} copy={undefined} />
					<ul className="m-0 flex list-none flex-col gap-1 p-0">
						{g.items.map((text) => (
							<li key={text} data-kind="described" className="mono flex items-start gap-2 text-[13px] leading-[1.5]">
								<Dot warm />
								<span className="min-w-0 flex-grow text-ink">{text}</span>
							</li>
						))}
					</ul>
				</div>
			))}
		</>
	);
}

export function RecapCard({ data, polishBody }: { data: RecapResponse; polishBody: Record<string, string> }) {
	const [polished, setPolished] = useState<{ polished: PolishedRecap; text: string; markdown: string } | null>(null);
	const [showOriginal, setShowOriginal] = useState(false);
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string | null>(null);
	const [active, setActive] = useState<RecapBullet | null>(null);
	const r = data.recap;
	const empty = r.sessions === 0;
	const showPolished = polished !== null && !showOriginal;
	const text = showPolished ? polished.text : data.text;
	const markdown = showPolished ? polished.markdown : data.markdown;
	const allGroups = r.groupBy === "day" ? r.days.flatMap((d) => d.groups) : r.groups;
	const repos = new Set(allGroups.map((g) => g.repo)).size;
	const items = allGroups.reduce((n, g) => n + g.bullets.length, 0);
	const singleDay = r.range.from === r.range.to;
	const days =
		Math.round(
			(new Date(`${r.range.to}T12:00:00`).getTime() - new Date(`${r.range.from}T12:00:00`).getTime()) / 86_400_000,
		) + 1;
	const withDay = !singleDay && r.groupBy === "repo";

	const polish = async () => {
		setBusy(true);
		setFailure(null);
		try {
			setPolished(await sendJson<RecapPolishResponse>("POST", "/api/recap/polish", polishBody));
			setShowOriginal(false);
		} catch (e) {
			const msg = e instanceof ApiErrorClass ? e.message : String(e);
			setFailure(msg.charAt(0).toUpperCase() + msg.slice(1));
		} finally {
			setBusy(false);
		}
	};

	return (
		<section aria-label="Recap" className="card mx-auto w-full max-w-[680px] overflow-hidden">
			<div className="flex flex-wrap items-end gap-2 border-b border-row px-[18px] pt-3.5 pb-3">
				<div className="min-w-0 flex-grow">
					<div className="section-h">Recap</div>
					<h2 className="mono m-0 mt-1 text-[19px] font-semibold">{rangeLabel(r.range.from, r.range.to)}</h2>
				</div>
				{empty ? null : (
					<div className="flex flex-wrap items-center gap-2">
						{polished ? (
							<span className="rounded-full bg-accent-fill px-2 py-0.5 text-[12px] font-medium text-accent">
								Polished with AI · {cost(polished.polished.costUsd)}
							</span>
						) : null}
						{polished ? (
							<button
								type="button"
								onClick={() => setShowOriginal((v) => !v)}
								className="rounded-[7px] border border-border bg-panel px-2.5 py-1 text-[12.5px] text-neutral-text hover:text-ink"
							>
								{showOriginal ? "Show polished" : "Show original"}
							</button>
						) : null}
						<CopyButton text={text} label="Copy text" />
						<CopyButton text={markdown} label="Copy Markdown" />
						{polished ? null : (
							<button
								type="button"
								onClick={polish}
								disabled={busy}
								className="inline-flex items-center gap-1.5 rounded-[7px] border-0 bg-ink px-2.5 py-1 text-[12.5px] font-medium text-panel disabled:opacity-70"
							>
								{busy ? (
									<>
										<svg
											width="12"
											height="12"
											viewBox="0 0 24 24"
											fill="none"
											stroke="currentColor"
											strokeWidth="2.5"
											strokeLinecap="round"
											aria-hidden="true"
											className="animate-spin"
										>
											<path d="M12 3a9 9 0 1 0 9 9" />
										</svg>
										Polishing…
									</>
								) : (
									`Polish with AI (${data.polishEstUsd === null ? "cost unknown" : `~${usd(data.polishEstUsd)}`})`
								)}
							</button>
						)}
					</div>
				)}
			</div>
			{failure ? <div className="border-b border-row px-[18px] py-2 text-[12.5px] text-bad">{failure}</div> : null}
			<div className="px-[18px] pt-1 pb-4">
				{empty ? (
					<>
						<p className="mono m-0 pt-3 text-[13px]">{data.text}</p>
						<div className="pt-2 text-[12.5px]">
							<Link href="/sessions">See all sessions</Link>
						</div>
					</>
				) : showPolished ? (
					<Polished polished={polished.polished} />
				) : r.groupBy === "day" ? (
					r.days.map((d) => (
						<div key={d.date} className="pt-2">
							<h3 className="section-h m-0 pt-2">{dayLabel(d.date)}</h3>
							{d.groups.map((g) => (
								<Group key={g.repo} group={g} copy={data.repoText[g.repo]?.text} withDay={false} onBullet={setActive} />
							))}
						</div>
					))
				) : (
					r.groups.map((g) => (
						<Group key={g.repo} group={g} copy={data.repoText[g.repo]?.text} withDay={withDay} onBullet={setActive} />
					))
				)}
			</div>
			{empty ? null : (
				<>
					<div className="flex flex-col gap-2 border-t-[3px] border-double border-border px-[18px] pt-3 pb-3">
						<div className="mono flex items-center gap-2 text-[12px]">
							<span className="font-semibold tracking-[0.06em]">{singleDay ? "END OF DAY" : `${days} DAYS`}</span>
							<span aria-hidden="true" className="h-0 flex-grow border-b border-dotted border-muted opacity-50" />
							<span className="text-muted">{plural(items, "item")}</span>
						</div>
						<ActivityStrip activity={r.activity} today={singleDay && r.range.from === localDate(new Date())} />
					</div>
					<div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-row px-[18px] py-2.5 text-[12px] text-muted">
						<span>
							{plural(r.sessions, "session")} · {plural(repos, "repo")}
							{r.hiddenRepos > 0 ? " · " : ""}
							{r.hiddenRepos > 0 ? (
								<Link href="/settings#recap">{plural(r.hiddenRepos, "repo")} hidden · Settings</Link>
							) : null}
						</span>
						<div className="flex-grow" />
						<span role="status" aria-label="Bullet source" className="inline-flex flex-wrap items-center gap-1.5">
							{active && !showPolished ? (
								<>
									<span>
										{SOURCE[active.source]}
										{active.sessionIds.length > 1 ? ` · ${active.sessionIds.length} sessions` : ""}
									</span>
									{active.sessionIds.map((id) => (
										<Link key={id} href={`/sessions/${encodeURIComponent(id)}`} className="mono">
											{id.slice(0, 8)}
										</Link>
									))}
								</>
							) : null}
						</span>
					</div>
				</>
			)}
		</section>
	);
}

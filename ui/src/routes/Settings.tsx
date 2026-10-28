// Settings (feature 16; mockup Settings.html): every control saves on change or blur through PUT /api/config, the
// same sparse config.json the CLI writes. Reviews, auto-review and drafts show their cost before they turn on;
// lowering retention shows how many sessions the next run deletes before it saves.
import type { ConfigPatch, ConfigResponse, ConfigUpdateResponse, RetentionPreview } from "@api-types";
import { type ReactNode, useEffect, useState } from "react";
import { ApiErrorClass, getJson, sendJson } from "../api";
import { BudgetField } from "../components/BudgetField";
import { ConfigBanner } from "../components/ConfigBanner";
import { DemotedRules } from "../components/DemotedRules";
import { ErrorCard } from "../components/ErrorCard";
import { HiddenReposField } from "../components/HiddenReposField";
import { NumberField } from "../components/NumberField";
import { PricingSection } from "../components/PricingSection";
import { RedactList } from "../components/RedactList";
import { SkeletonCard } from "../components/Skeleton";
import { Toggle } from "../components/Toggle";
import { TopBar } from "../components/TopBar";
import { UsageTable } from "../components/UsageTable";
import { formatBytes, num, usd } from "../lib/format";
import { useApi } from "../lib/useApi";
import { useRefreshStatus } from "../lib/useLiveRefresh";

const MB_PER_SESSION = 0.8; // feature 14, storage size

type Confirm = "review" | "auto" | "drafts";

function Row({
	children,
	sub = false,
	dim = false,
	id,
}: {
	children: ReactNode;
	sub?: boolean;
	dim?: boolean;
	id?: string;
}) {
	return (
		<div
			id={id}
			className={`flex items-start gap-3.5 border-t border-row px-[18px] py-3.5 first:border-t-0 ${sub ? "pl-[52px]" : ""} ${dim ? "opacity-60" : ""}`}
		>
			{children}
		</div>
	);
}

function Text({ label, note, small = false }: { label: string; note?: ReactNode; small?: boolean }) {
	return (
		<div className="min-w-0 flex-grow">
			<div className={`font-medium ${small ? "text-[13.5px]" : "text-[14px]"}`}>{label}</div>
			{note ? <div className="mt-0.5 text-[12.5px] leading-snug text-muted">{note}</div> : null}
		</div>
	);
}

function Note({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
	return (
		<div className="mt-2 flex flex-wrap items-center gap-2.5 rounded-lg bg-amber-fill px-2.5 py-2 text-[12.5px] text-amber">
			<span className="min-w-0 flex-grow">{children}</span>
			{actions}
		</div>
	);
}

const button = "rounded-md border border-border bg-panel px-2.5 py-1 text-[12.5px] font-medium text-ink";
const primary = "rounded-md border border-ink bg-ink px-2.5 py-1 text-[12.5px] font-medium text-background";

function CopyCommand({ command, note }: { command: string; note: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<div className="flex items-center gap-2 rounded-md border border-border bg-band py-1 pr-1.5 pl-2.5 text-[12.5px]">
			<span className="mono flex-grow">{command}</span>
			<span className="text-[12px] text-muted">{note}</span>
			<button
				type="button"
				className={button}
				aria-label={`Copy ${command}`}
				onClick={() => {
					void navigator.clipboard?.writeText(command).then(() => setCopied(true));
				}}
			>
				{copied ? "Copied" : "Copy"}
			</button>
		</div>
	);
}

export function Settings() {
	const { data, error, reload } = useApi<ConfigResponse>("/api/config");
	const refreshStatus = useRefreshStatus();
	const [confirm, setConfirm] = useState<Confirm | null>(null);
	const [retention, setRetention] = useState<{ days: number; sessions: number } | null>(null);
	const [retentionReset, setRetentionReset] = useState(0);
	const [hookNote, setHookNote] = useState<boolean | null>(null);
	const [tipsReset, setTipsReset] = useState(false);
	const [model, setModel] = useState("");
	const [modelError, setModelError] = useState<string | null>(null);

	useEffect(() => setModel(data?.config.ai.model ?? ""), [data?.config.ai.model]);
	// While a re-price job runs (Phase 7 P7), reload every 2 s for its progress.
	const repricing = data?.pricing?.repricing !== null && data?.pricing?.repricing !== undefined;
	useEffect(() => {
		if (!repricing) return;
		const t = setInterval(reload, 2000);
		return () => clearInterval(t);
	}, [repricing, reload]);
	// /settings#reviews (the nudge's "Enable reviews" link) lands on the reviews toggle.
	useEffect(() => {
		if (data && window.location.hash) document.getElementById(window.location.hash.slice(1))?.scrollIntoView?.();
	}, [data]);

	/** Saves a patch; returns the message to show under the control, or null. */
	const save = async (patch: ConfigPatch): Promise<string | null> => {
		try {
			await sendJson<ConfigUpdateResponse>("PUT", "/api/config", patch);
			reload();
			refreshStatus();
			return null;
		} catch (e) {
			if (e instanceof ApiErrorClass) return e.fields[0]?.message ?? e.message;
			return String(e);
		}
	};
	const set = (key: string, value: unknown) => save({ set: { [key]: value } });

	const top = (
		<TopBar title="Settings">
			<span className="text-[12.5px] text-muted">Changes save as you make them</span>
		</TopBar>
	);
	if (error && !data)
		return (
			<>
				{top}
				<ErrorCard error={error} onRetry={reload} />
			</>
		);
	if (!data)
		return (
			<>
				{top}
				<SkeletonCard height={480} />
			</>
		);

	const c = data.config;
	const est = data.estimates;
	const reviewsOn = c.ai.review.enabled;
	const each = (v: number | null, what: string) =>
		v === null ? `Cost per ${what} not known until the first one runs.` : `About ${usd(v)} per ${what}.`;

	const commitRetention = async (days: number): Promise<string | null> => {
		if (days > 0 && (c.retention.days === 0 || days < c.retention.days)) {
			try {
				const p = await getJson<RetentionPreview>("/api/config/retention-preview", { days });
				setRetention({ days, sessions: p.sessions });
				return null;
			} catch (e) {
				return e instanceof Error ? e.message : String(e);
			}
		}
		return set("retention.days", days);
	};

	return (
		<>
			{top}
			<ConfigBanner errors={data.errors} path={data.path} />
			<div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-2">
				{/* AI features */}
				<section className="card" aria-labelledby="ai-h">
					<div className="px-[18px] pt-3.5 pb-1">
						<h2 id="ai-h" className="section-h m-0">
							AI features
						</h2>
						<p className="m-0 mt-0.5 text-[12.5px] text-muted">
							Each call runs <span className="mono">claude -p</span> on your own Claude Code login and counts toward
							your plan.
						</p>
					</div>
					<Row>
						<Toggle
							checked={c.ai.summaries.enabled}
							label="Session summaries"
							onChange={(v) => set("ai.summaries.enabled", v)}
						/>
						<Text
							label="Session summaries"
							note={`one claude -p call per finished session · ${est.summaryUsd === null ? "cost not known yet" : `~${usd(est.summaryUsd)} each`}`}
						/>
					</Row>
					<Row sub dim={!c.ai.summaries.enabled}>
						<Text
							small
							label="Summaries per day"
							note={`${num(data.usedToday.summaries)} used today · ${num(data.pendingSummaries)} pending`}
						/>
						<NumberField label="Summaries per day" value={c.ai.maxPerDay} onCommit={(v) => set("ai.maxPerDay", v)} />
					</Row>

					<Row id="reviews">
						<Toggle
							checked={reviewsOn}
							label="Tier 2 reviews"
							onChange={(v) => {
								if (v) return setConfirm("review");
								setConfirm(null);
								void set("ai.review.enabled", false);
							}}
						/>
						<div className="min-w-0 flex-grow">
							<Text
								label="Tier 2 reviews"
								note="A deeper look at one session: goal drift, review friction, what to do differently."
							/>
							{confirm === "review" ? (
								<Note
									actions={
										<>
											<button type="button" className={button} onClick={() => setConfirm(null)}>
												Cancel
											</button>
											<button
												type="button"
												className={primary}
												onClick={() => {
													setConfirm(null);
													void set("ai.review.enabled", true);
												}}
											>
												Turn on reviews
											</button>
										</>
									}
								>
									{each(est.reviewUsd, "review")} On your plan; reviews run on click
									{c.ai.review.auto ? " and automatically for long sessions" : ""}, up to {num(c.ai.review.maxPerDay)} a
									day.
								</Note>
							) : null}
						</div>
					</Row>
					<Row sub dim={!reviewsOn}>
						<Text small label="Reviews per day" note={`${num(data.usedToday.reviews)} used today`} />
						<NumberField
							label="Reviews per day"
							value={c.ai.review.maxPerDay}
							disabled={!reviewsOn}
							onCommit={(v) => set("ai.review.maxPerDay", v)}
						/>
					</Row>
					<Row sub dim={!reviewsOn}>
						<Toggle
							checked={c.ai.review.auto}
							label="Auto-review long sessions"
							disabled={!reviewsOn}
							onChange={(v) => (v ? setConfirm("auto") : void set("ai.review.auto", false))}
						/>
						<div className="min-w-0 flex-grow">
							<Text small label="Auto-review long sessions" />
							<div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[12.5px] text-muted">
								more than
								<NumberField
									label="Auto-review turns"
									width="w-[64px]"
									value={c.ai.review.autoThreshold.turns}
									disabled={!reviewsOn}
									onCommit={(v) => set("ai.review.autoThreshold.turns", v)}
								/>
								turns or
								<NumberField
									label="Auto-review tokens"
									width="w-[100px]"
									value={c.ai.review.autoThreshold.tokens}
									disabled={!reviewsOn}
									onCommit={(v) => set("ai.review.autoThreshold.tokens", v)}
								/>
								non-cached tokens, or any high-severity Tier 1 finding
							</div>
							{reviewsOn ? null : <div className="mt-0.5 text-[12.5px] text-muted">Needs Tier 2 reviews on.</div>}
							{confirm === "auto" ? (
								<Note
									actions={
										<>
											<button type="button" className={button} onClick={() => setConfirm(null)}>
												Cancel
											</button>
											<button
												type="button"
												className={primary}
												onClick={() => {
													setConfirm(null);
													void set("ai.review.auto", true);
												}}
											>
												Turn on auto-review
											</button>
										</>
									}
								>
									{each(est.reviewUsd, "review")} Up to {num(c.ai.review.maxPerDay)} automatic reviews a day.
								</Note>
							) : null}
						</div>
					</Row>

					<Row>
						<Toggle
							checked={c.ai.drafts.enabled}
							label="Skill drafts"
							onChange={(v) => (v ? setConfirm("drafts") : void set("ai.drafts.enabled", false))}
						/>
						<div className="min-w-0 flex-grow">
							<Text
								label="Skill drafts"
								note="Draft a skill from a repeated pattern, on click only. CLAUDE.md suggestions work without it."
							/>
							{confirm === "drafts" ? (
								<Note
									actions={
										<>
											<button type="button" className={button} onClick={() => setConfirm(null)}>
												Cancel
											</button>
											<button
												type="button"
												className={primary}
												onClick={() => {
													setConfirm(null);
													void set("ai.drafts.enabled", true);
												}}
											>
												Turn on drafts
											</button>
										</>
									}
								>
									{each(est.draftUsd, "draft")} Only when you click Draft.
								</Note>
							) : null}
						</div>
					</Row>

					<Row>
						<Text
							label="Model for tracker calls"
							note={
								c.ai.model
									? "Pinned: every summary and review runs on this model."
									: "Unset: summaries and reviews run on Claude Code's default model."
							}
						/>
						<span className="inline-flex flex-col items-end gap-1">
							<input
								aria-label="Model for tracker calls"
								placeholder="Claude Code default"
								value={model}
								onChange={(e) => setModel(e.target.value)}
								onBlur={async () => {
									const next = model.trim();
									if (next === (c.ai.model ?? "")) return;
									const message = await save(next ? { set: { "ai.model": next } } : { unset: ["ai.model"] });
									setModelError(message);
									if (message) setModel(c.ai.model ?? "");
								}}
								className="mono w-[190px] rounded-md border border-border bg-panel px-2 py-1.5 text-[13px] text-ink"
							/>
							{modelError ? <span className="text-[12px] text-bad">{modelError}</span> : null}
						</span>
					</Row>

					<Row>
						<div className="min-w-0 flex-grow">
							<div className="text-[14px] font-medium">Demoted coaching rules</div>
							<DemotedRules rules={data.demotedRules} onChanged={reload} />
						</div>
					</Row>
				</section>

				{/* Capture & retention */}
				<section className="card" aria-labelledby="cap-h">
					<div className="px-[18px] pt-3.5 pb-1">
						<h2 id="cap-h" className="section-h m-0">
							Capture &amp; retention
						</h2>
						<p className="m-0 mt-0.5 text-[12.5px] text-muted">
							Applies to new captures; stored data keeps the redaction it had.
						</p>
					</div>
					<Row>
						<div className="min-w-0 flex-grow">
							<div className="mb-2 text-[14px] font-medium">Redaction patterns</div>
							<RedactList
								patterns={c.capture.redact}
								defaultCount={data.defaultRedactCount}
								onSave={(next) => set("capture.redact", next)}
							/>
						</div>
					</Row>
					<Row>
						<Toggle
							checked={c.capture.permissionHook}
							label="Record permission prompts"
							onChange={async (v) => {
								if (!(await set("capture.permissionHook", v))) setHookNote(v);
							}}
						/>
						<div className="min-w-0 flex-grow">
							<Text
								label="Record permission prompts"
								note="adds about 0.1 s to each permission prompt · feeds the permission-friction finding"
							/>
							{hookNote !== null ? (
								<Note>
									Run <span className="mono">cc-debrief init</span> to {hookNote ? "add" : "remove"} the hook entry as
									well.
								</Note>
							) : null}
						</div>
					</Row>
					<Row>
						<Text label="Max field size" note="Longer text fields are cut and marked “truncated”." />
						<span className="inline-flex items-center gap-1.5 text-[13px] text-muted">
							<NumberField
								label="Max field size (KB)"
								scale={1024}
								value={c.capture.maxFieldBytes}
								onCommit={(v) => set("capture.maxFieldBytes", v)}
							/>
							KB
						</span>
					</Row>
					<div className="flex flex-wrap items-start gap-3.5 border-t border-row px-[18px] py-3.5">
						<Text label="Keep data for" note={`About ${MB_PER_SESSION} MB per session. 0 keeps everything.`} />
						<span className="inline-flex items-center gap-1.5 text-[13px] text-muted">
							<NumberField
								label="Keep data for (days)"
								value={c.retention.days}
								resetToken={retentionReset}
								onCommit={commitRetention}
							/>
							days
						</span>
						{retention ? (
							<div className="basis-full">
								<Note
									actions={
										<>
											<button
												type="button"
												className={button}
												onClick={() => {
													setRetention(null);
													setRetentionReset((n) => n + 1);
												}}
											>
												Cancel
											</button>
											<button
												type="button"
												className={primary}
												onClick={async () => {
													const days = retention.days;
													setRetention(null);
													await set("retention.days", days);
												}}
											>
												Save {retention.days} days
											</button>
										</>
									}
								>
									Next retention run deletes {num(retention.sessions)} sessions (≈{" "}
									{Math.round(retention.sessions * MB_PER_SESSION)} MB) older than {retention.days} days.
								</Note>
							</div>
						) : null}
					</div>
					<Row>
						<Text label="Dashboard" note="Port and live refresh apply on next start." />
						<span className="inline-flex shrink-0 items-center gap-1.5 text-[13px] text-muted">
							port
							<NumberField label="Dashboard port" value={c.dashboard.port} onCommit={(v) => set("dashboard.port", v)} />
							refresh
							<NumberField
								label="Live refresh seconds"
								width="w-[64px]"
								value={c.dashboard.pollSeconds}
								onCommit={(v) => set("dashboard.pollSeconds", v)}
							/>
							s
						</span>
					</Row>
					<div className="flex flex-col gap-2 border-t border-row px-[18px] py-3.5">
						<div>
							<div className="text-[14px] font-medium">Your data</div>
							<div className="mono mt-0.5 text-[12.5px] break-all text-muted">
								{data.dataDir} · {Math.round(data.dbBytes / (1024 * 1024))} MB
							</div>
							<div className="mt-0.5 text-[12.5px] text-muted">
								Claude Code transcripts (~/.claude/projects) ·{" "}
								{formatBytes({ bytes: data.storage.projectsBytes, cut: data.storage.projectsCut })}
							</div>
						</div>
						<CopyCommand command="cc-debrief purge" note="delete data older than the window" />
						<CopyCommand command="cc-debrief uninit" note="remove the hooks" />
					</div>
					<Row>
						<div className="flex-grow text-[12.5px] text-muted">
							{tipsReset ? "Tips will show again." : "Dismissed the reviews tip?"}
						</div>
						<button
							type="button"
							className="border-0 bg-transparent p-0 text-[12.5px] font-medium text-accent"
							onClick={async () => {
								await sendJson("POST", "/api/nudges/reset");
								setTipsReset(true);
							}}
						>
							Show tips again
						</button>
					</Row>
				</section>

				{/* Recap (Phase 6, feature 17) */}
				<section id="recap" className="card" aria-labelledby="recap-h">
					<div className="px-[18px] pt-3.5 pb-1">
						<h2 id="recap-h" className="section-h m-0">
							Recap
						</h2>
						<p className="m-0 mt-0.5 text-[12.5px] text-muted">Repos left out of every recap, copy and polish.</p>
					</div>
					<Row>
						<div className="min-w-0 flex-grow">
							<div className="mb-2 text-[14px] font-medium">Hidden repos</div>
							<HiddenReposField hidden={c.recap.hiddenRepos} onSave={(next) => set("recap.hiddenRepos", next)} />
							<p className="m-0 mt-2.5 text-[12.5px] text-muted">
								Hiding a repo removes its sessions and files from the recap. It cannot remove words about that work from
								a session title or summary in another repo.
							</p>
						</div>
					</Row>
				</section>

				{/* Budget (Phase 7 P4, feature 18) */}
				<section id="budget" className="card" aria-labelledby="budget-h">
					<div className="px-[18px] pt-3.5 pb-1">
						<h2 id="budget-h" className="section-h m-0">
							Budget
						</h2>
						<p className="m-0 mt-0.5 text-[12.5px] text-muted">
							A band on Overview and Costs, and a digest item when the month is on pace to pass it.
						</p>
					</div>
					<Row>
						<Text label="Monthly budget" note="Your sessions at API prices; the tracker's own calls are not counted." />
						<BudgetField
							value={c.budget.monthlyUsd}
							onCommit={(v) => (v === null ? save({ unset: ["budget.monthlyUsd"] }) : set("budget.monthlyUsd", v))}
						/>
					</Row>
				</section>

				<PricingSection pricing={data.pricing} overrides={c.pricing.overrides} save={save} />
			</div>
			<UsageTable />
		</>
	);
}

// Sidebar (feature 12): logo, nav, Settings at the foot, and the status lines from GET /api/status.
import type { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { relTime } from "../lib/format";
import { useStatus } from "../lib/useLiveRefresh";

const icon = (d: ReactNode) => (
	<svg
		width="16"
		height="16"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		strokeWidth="2"
		strokeLinecap="round"
		aria-hidden="true"
	>
		{d}
	</svg>
);

const NAV: { href: string; label: string; icon: ReactNode }[] = [
	{
		href: "/",
		label: "Overview",
		icon: icon(
			<>
				<rect x="3" y="3" width="8" height="8" rx="1.5" />
				<rect x="13" y="3" width="8" height="8" rx="1.5" />
				<rect x="3" y="13" width="8" height="8" rx="1.5" />
				<rect x="13" y="13" width="8" height="8" rx="1.5" />
			</>,
		),
	},
	{
		href: "/activity",
		label: "Activity",
		icon: icon(
			<>
				<rect x="3" y="4" width="18" height="17" rx="2" />
				<path d="M3 9h18M8 2v4M16 2v4M8 14h2M14 14h2M8 18h2" />
			</>,
		),
	},
	{
		href: "/costs",
		label: "Costs",
		icon: icon(
			<>
				<path d="M12 2v20" />
				<path d="M17 6H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
			</>,
		),
	},
	{ href: "/sessions", label: "Sessions", icon: icon(<path d="M4 6h16M4 12h16M4 18h10" />) },
	{
		href: "/skills",
		label: "Skills & Tools",
		icon: icon(<path d="M14.7 6.3a4 4 0 0 0 5 5l-9.4 9.4a2.1 2.1 0 0 1-3-3l9.4-9.4z" />),
	},
	{
		href: "/repos",
		label: "Repos",
		icon: icon(
			<>
				<circle cx="6" cy="6" r="3" />
				<circle cx="18" cy="18" r="3" />
				<path d="M6 9v3a4 4 0 0 0 4 4h5" />
			</>,
		),
	},
	{
		href: "/recap",
		label: "Recap",
		icon: icon(
			<>
				<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" />
				<path d="M9 8h6M9 12h6M9 16h3" />
			</>,
		),
	},
	{
		href: "/tasks",
		label: "Tasks & plans",
		icon: icon(
			<>
				<path d="M9 6h11M9 12h11M9 18h11" />
				<path d="M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2" />
			</>,
		),
	},
];

function NavLink({
	href,
	label,
	children,
	active,
}: {
	href: string;
	label: string;
	children: ReactNode;
	active: boolean;
}) {
	return (
		<Link
			href={href}
			aria-current={active ? "page" : undefined}
			className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-[14px] no-underline ${
				active ? "bg-panel font-semibold text-ink shadow-[0_0_0_1px_var(--color-border)]" : "text-muted hover:text-ink"
			}`}
		>
			{children}
			{label}
		</Link>
	);
}

export function Sidebar() {
	const [location] = useLocation();
	const status = useStatus();
	const isActive = (href: string) =>
		href === "/" ? location === "/" : location === href || location.startsWith(`${href}/`);
	return (
		<nav aria-label="Main" className="flex w-[220px] shrink-0 flex-col gap-1 border-r border-border px-3.5 py-5">
			<div className="flex items-center gap-2.5 px-2 pt-1 pb-[18px]">
				<div className="flex h-[26px] w-[26px] items-center justify-center rounded-[7px] bg-ink">
					<svg
						width="14"
						height="14"
						viewBox="0 0 24 24"
						fill="none"
						stroke="var(--color-background)"
						strokeWidth="2.5"
						strokeLinecap="round"
						aria-hidden="true"
					>
						<path d="M4 18V9M10 18V5M16 18v-7M22 18H2" />
					</svg>
				</div>
				<div className="text-[15px] font-semibold">cc-debrief</div>
			</div>
			{NAV.map((n) => (
				<NavLink key={n.href} href={n.href} label={n.label} active={isActive(n.href)}>
					{n.icon}
				</NavLink>
			))}
			<div className="flex-grow" />
			<NavLink href="/settings" label="Settings" active={isActive("/settings")}>
				{icon(<circle cx="12" cy="12" r="3" />)}
			</NavLink>
			{status ? (
				<div className="px-3 pt-1.5 pb-2.5 text-[12px] leading-normal text-muted">
					<div>
						AI: summaries {status.ai.summaries ? "on" : "off"} · reviews {status.ai.reviews ? "on" : "off"}
					</div>
					<div>Local only · last ingest {relTime(status.lastIngestAt)}</div>
					{status.pendingSummaries > 0 ? <div>{status.pendingSummaries} summaries pending</div> : null}
					{status.hooksInstalled ? null : (
						<div className="text-amber">
							Hooks off · run <code className="mono">cc-debrief init</code>
						</div>
					)}
				</div>
			) : null}
		</nav>
	);
}

/** Thin bar under the top bar while a backfill runs: "Importing history · 120/283". */
export function BackfillBar() {
	const status = useStatus();
	const b = status?.backfill;
	if (!b) return null;
	const pct = b.total > 0 ? Math.round((b.done / b.total) * 100) : 0;
	return (
		<div className="flex items-center gap-3 text-[12px] text-muted">
			<div
				role="progressbar"
				aria-label="Importing history"
				aria-valuemin={0}
				aria-valuemax={b.total}
				aria-valuenow={b.done}
				className="h-1 flex-grow overflow-hidden rounded-full bg-neutral-fill"
			>
				<div className="h-full bg-accent" style={{ width: `${pct}%` }} />
			</div>
			<span>
				Importing history · {b.done}/{b.total}
			</span>
		</div>
	);
}

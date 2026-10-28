// A small donut chart (Phase 7 P13; mockup note in Costs.html): slices as dashed circle strokes on a 100-unit
// circumference, a centre value and a legend. One slice is a full ring; no slices is the outline and a dash.
const COLORS = [
	"var(--color-series-input)",
	"var(--color-series-cache-read)",
	"var(--color-series-output)",
	"var(--color-warm)",
	"var(--color-good)",
	"var(--color-bad)",
	"var(--color-muted)",
];
// r = 100 / (2π): the circumference is 100, so a slice's dash length is its percent.
const R = 15.915494;

export type DonutSlice = { label: string; value: number; text: string };

export function Donut({ title, center, slices }: { title: string; center: string; slices: DonutSlice[] }) {
	const total = slices.reduce((n, s) => n + s.value, 0);
	const shown = total > 0 ? slices.filter((s) => s.value > 0) : [];
	let offset = 0;
	const label =
		shown.length > 0 ? `${title}: ${shown.map((s) => `${s.label} ${s.text}`).join(", ")}` : `${title}: none`;
	return (
		<figure className="card m-0 flex items-center gap-4 px-[18px] py-4" aria-label={label}>
			<div className="relative h-[120px] w-[120px] shrink-0">
				<svg viewBox="0 0 42 42" className="h-full w-full -rotate-90" aria-hidden="true">
					<circle cx="21" cy="21" r={R} fill="none" stroke="var(--color-row)" strokeWidth="6" />
					{shown.map((s, i) => {
						const pct = (s.value / total) * 100;
						const dash = Number(pct.toFixed(4));
						const el = (
							<circle
								key={s.label}
								data-slice={s.label}
								cx="21"
								cy="21"
								r={R}
								fill="none"
								stroke={COLORS[i % COLORS.length]}
								strokeWidth="6"
								strokeDasharray={`${dash} ${Number((100 - dash).toFixed(4))}`}
								strokeDashoffset={-offset}
							/>
						);
						offset += pct;
						return el;
					})}
				</svg>
				<div className="mono absolute inset-0 flex items-center justify-center text-[14px] font-medium">
					{shown.length > 0 ? center : "—"}
				</div>
			</div>
			<div className="min-w-0 flex-grow">
				<div className="section-h mb-1.5">{title}</div>
				<ul className="m-0 flex list-none flex-col gap-1 p-0 text-[12.5px]">
					{shown.map((s, i) => (
						<li key={s.label} className="flex items-center gap-2">
							<span
								className="inline-block h-2.5 w-2.5 shrink-0 rounded-[2px]"
								style={{ background: COLORS[i % COLORS.length] }}
							/>
							<span className="min-w-0 flex-grow truncate">{s.label}</span>
							<span className="mono text-muted">{s.text}</span>
						</li>
					))}
				</ul>
			</div>
		</figure>
	);
}

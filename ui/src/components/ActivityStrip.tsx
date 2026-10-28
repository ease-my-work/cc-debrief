// The recap footer's activity strip: the day as 96 quarter
// hours. A slot with turns is a bar whose height follows its turn count; an idle slot is a faint tick; on today, the
// slots still ahead ("rest of day") are dots after a warm "now" line. A multi-day range sums the days by time of day.
import type { RecapActivity } from "@api-types";
import type { ReactNode } from "react";

const SLOTS = 96;
const W = 4;
const H = 26;

const hm = (slot: number) =>
	`${String(Math.floor(slot / 4)).padStart(2, "0")}:${String((slot % 4) * 15).padStart(2, "0")}`;
const duration = (min: number) => (min < 60 ? `${min}m` : `${Math.floor(min / 60)}h${min % 60 ? ` ${min % 60}m` : ""}`);

export function ActivityStrip({ activity, today }: { activity: RecapActivity[]; today: boolean }) {
	const sum = new Array<number>(SLOTS).fill(0);
	for (const a of activity) for (let i = 0; i < SLOTS; i++) sum[i] += a.slots[i] ?? 0;
	const max = Math.max(1, ...sum);
	const now = new Date();
	const nowSlot = now.getHours() * 4 + Math.floor(now.getMinutes() / 15);
	const work = sum.flatMap((v, i) => (v > 0 ? [i] : []));
	const label = work.length
		? `Activity: ${duration(work.length * 15)} active, ${hm(work[0])}–${hm((work.at(-1) as number) + 1)}`
		: "Activity: none";
	// One element per quarter hour, keyed by its start time.
	const bars: ReactNode[] = [];
	for (let i = 0; i < SLOTS; i++) {
		const x = i * W + 0.75;
		const v = sum[i];
		const key = hm(i);
		if (v > 0) {
			const h = 8 + (H - 8) * (v / max);
			bars.push(
				<rect key={key} data-slot="work" x={x} y={H - h} width={2.5} height={h} rx={0.6} className="fill-ink" />,
			);
		} else if (today && i > nowSlot)
			bars.push(
				<rect
					key={key}
					data-slot="later"
					x={x + 0.5}
					y={H - 2}
					width={1.5}
					height={1.5}
					rx={0.75}
					className="fill-border"
				/>,
			);
		else
			bars.push(
				<rect key={key} data-slot="idle" x={x + 0.5} y={H - 6} width={1.5} height={6} className="fill-border" />,
			);
	}
	return (
		<div className="flex flex-col gap-1">
			<svg
				role="img"
				aria-label={label}
				viewBox={`0 0 ${SLOTS * W} ${H}`}
				preserveAspectRatio="none"
				className="block h-[26px] w-full"
			>
				{bars}
				{today ? <rect x={nowSlot * W + W} y={0} width={0.75} height={H} className="fill-warm" /> : null}
			</svg>
			<div aria-hidden="true" className="mono flex justify-between text-[10.5px] text-muted">
				<span>00</span>
				<span>06</span>
				<span>12</span>
				<span>18</span>
				<span>24</span>
			</div>
		</div>
	);
}

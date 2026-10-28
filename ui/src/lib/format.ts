// Display formatting (feature 12 "Formatting rules"). Times are shown in the viewer's local time zone.

const MINUS = "−";

/** 950, 1.0k, 388k, 3.8M, 12M; truncated, never rounded up (999,999 → 999k). */
export function compactTokens(n: number): string {
	const scaled = (v: number, unit: string) =>
		v < 10 ? `${(Math.floor(v * 10) / 10).toFixed(1)}${unit}` : `${Math.floor(v)}${unit}`;
	if (n < 1_000) return String(Math.round(n));
	if (n < 1_000_000) return scaled(n / 1_000, "k");
	if (n < 1_000_000_000) return scaled(n / 1_000_000, "M");
	return scaled(n / 1_000_000_000, "B");
}

/** A list item's tokens: "tokens unknown" without usage rows, "≥ 12k" for a counted (partial) total, else "12k". */
export function tokenText(s: { tokens: number; partial: boolean; tokensUnknown: boolean }): string {
	if (s.tokensUnknown) return "tokens unknown";
	return `${s.partial && s.tokens > 0 ? "≥ " : ""}${compactTokens(s.tokens)}`;
}

const money = new Intl.NumberFormat("en-US", {
	style: "currency",
	currency: "USD",
	minimumFractionDigits: 2,
	maximumFractionDigits: 2,
});
/** $18.40; — when unknown. */
export const usd = (v: number | null): string => (v === null ? "—" : money.format(v));

const grouped = new Intl.NumberFormat("en-US");
/** 2,140 */
export const num = (n: number): string => grouped.format(n);
/** +2,140 / −860 (true minus sign). */
export const signed = (n: number, sign: "+" | "-"): string => `${sign === "+" ? "+" : MINUS}${num(n)}`;

/** 1h 12m, 24m, <1m; running when the session has not ended. */
export function duration(seconds: number | null): string {
	if (seconds === null) return "running";
	if (seconds < 60) return "<1m";
	const m = Math.floor(seconds / 60);
	return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
const pad = (n: number) => String(n).padStart(2, "0");
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** 14:02 today, Yesterday, a weekday within 7 days, else 26 Sep. */
export function when(iso: string, now: Date = new Date()): string {
	const d = new Date(iso);
	const days = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
	if (days <= 0) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
	if (days === 1) return "Yesterday";
	if (days < 7) return WEEKDAYS[d.getDay()];
	return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** Sat 26 Sep (detail headers). */
export const dayLabel = (iso: string): string => {
	const d = new Date(iso);
	return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
};

/** 11:40 */
export const clock = (iso: string): string => {
	const d = new Date(iso);
	return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const FAMILIES = ["fable", "mythos", "opus", "sonnet", "haiku"];
const familyOf = (id: string) => {
	const f = FAMILIES.find((x) => id.toLowerCase().includes(x));
	return f ? f[0].toUpperCase() + f.slice(1) : id;
};

/** Opus, Sonnet, Haiku; "Opus → Sonnet" when the session switched; — when none. */
export function modelFamily(models: string[]): string {
	const labels: string[] = [];
	for (const m of models) {
		const l = familyOf(m);
		if (labels.at(-1) !== l) labels.push(l);
	}
	return labels.length ? labels.join(" → ") : "—";
}

/** a3f9…c21e */
export const shortId = (id: string): string => (id.length > 12 ? `${id.slice(0, 4)}…${id.slice(-4)}` : id);

/** just now, 2 min ago, 3 h ago, 2 days ago; never for null. */
export function relTime(iso: string | null, now: Date = new Date()): string {
	if (!iso) return "never";
	const s = Math.max(0, (now.getTime() - Date.parse(iso)) / 1000);
	if (s < 60) return "just now";
	if (s < 3600) return `${Math.floor(s / 60)} min ago`;
	if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
	const d = Math.floor(s / 86_400);
	return `${d} day${d === 1 ? "" : "s"} ago`;
}

const UNITS = ["B", "KB", "MB", "GB", "TB"];
/** 12 B, 1.5 KB, 3.0 GB; "≥ " when a size walk stopped early (same rule as the server's formatBytes). */
export function formatBytes(r: { bytes: number; cut: boolean }): string {
	let v = r.bytes;
	let u = 0;
	while (v >= 1024 && u < UNITS.length - 1) {
		v /= 1024;
		u++;
	}
	return `${r.cut ? "≥ " : ""}${u === 0 ? String(v) : v.toFixed(1)} ${UNITS[u]}`;
}

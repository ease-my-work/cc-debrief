// Small numeric helpers for the dashboard queries (SQLite has no median).

/** Median of the values; the mean of the middle two for an even count; null when empty. */
export function median(values: number[]): number | null {
	if (values.length === 0) return null;
	const s = [...values].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 === 1 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/** Milliseconds from started_at to ended_at, or null when either is missing. */
export function msBetween(r: { started_at: string | null; ended_at: string | null }): number | null {
	return r.started_at && r.ended_at ? Math.max(0, Date.parse(r.ended_at) - Date.parse(r.started_at)) : null;
}

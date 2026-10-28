// In-memory job progress the dashboard command updates and GET /api/status reads (one server per process).
import type { JobProgress } from "./types";

let backfill: JobProgress | null = null;

export function setBackfillProgress(p: JobProgress | null): void {
	backfill = p ? { ...p } : null;
}

export function getBackfillProgress(): JobProgress | null {
	return backfill ? { ...backfill } : null;
}

let tier1: JobProgress | null = null;

/** Tier 1 re-check on `dashboard` start (Phase 4 spec decision 1); null when not running. */
export function setTier1Progress(p: JobProgress | null): void {
	tier1 = p ? { ...p } : null;
}

export function getTier1Progress(): JobProgress | null {
	return tier1 ? { ...tier1 } : null;
}

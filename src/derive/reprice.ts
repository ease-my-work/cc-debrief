// Re-pricing after the effective price table changed (Phase 7 P7, feature 02): every derived session whose derive
// state carries another price version gets a full re-derive, which rewrites usage.cost_usd from its stored lines
// (token columns come out the same). The dashboard runs it on start and after a pricing change.
import type { Db } from "../db/adapter";
import { deriveSessions } from "../ingest/ingest";
import { withSessionLock } from "../locks";
import { activePricing } from "./pricing";
import { deriveSession } from "./session";

/** Session ids whose stored derive state was priced with another table version, oldest key first. */
export function stalePriceSessions(db: Db, version: string = activePricing().version): string[] {
	const out: string[] = [];
	for (const r of db
		.prepare("SELECT key, value FROM meta WHERE key LIKE 'derive:%' ORDER BY key")
		.all<{ key: string; value: string }>()) {
		let price: unknown;
		try {
			price = (JSON.parse(r.value) as { price?: unknown }).price;
		} catch {
			price = undefined;
		}
		if (price !== version) out.push(r.key.slice("derive:".length));
	}
	return out;
}

/**
 * Re-derives each stale session under its lock (a busy one is skipped and stays stale for the next run), yielding
 * between sessions. A session whose re-derive fails is counted and skipped, so one bad session never stops the rest
 * (it stays stale and is tried again next run).
 */
export async function repriceStale(
	db: Db,
	opts: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {},
): Promise<{ repriced: number; failed: number }> {
	const ids = stalePriceSessions(db);
	let done = 0;
	let repriced = 0;
	let failed = 0;
	for (const id of ids) {
		if (opts.signal?.aborted) break;
		try {
			const r = await withSessionLock(id, { waitMs: 0 }, async () => {
				deriveSessions(db, [id], { derive: (d, sid) => d.transaction(() => deriveSession(d, sid, { full: true })) });
			});
			if (r !== "busy") repriced++;
		} catch {
			failed++;
		}
		opts.onProgress?.(++done, ids.length);
		await new Promise((r) => setImmediate(r));
	}
	return { repriced, failed };
}

// Live refresh (feature 12): poll GET /api/status every pollSeconds; when lastIngestAt changes, the open view
// refetches. The provider holds the status for the sidebar; `version` counts ingest changes after the first load.
import type { StatusResponse } from "@api-types";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";
import { getJson } from "../api";

type Live = { status: StatusResponse | null; version: number };
const LiveContext = createContext<Live>({ status: null, version: 0 });
// Re-reads GET /api/status at once (after a Settings change, so the sidebar's AI line follows).
const RefreshContext = createContext<() => void>(() => {});

export function LiveStatusProvider({ children }: { children: ReactNode }) {
	const [live, setLive] = useState<Live>({ status: null, version: 0 });
	const last = useRef<string | null | undefined>(undefined);
	const refresh = useCallback(() => {
		getJson<StatusResponse>("/api/status")
			.then((s) => setLive((prev) => ({ ...prev, status: s })))
			.catch(() => {});
	}, []);

	useEffect(() => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		let stopped = false;
		const tick = async () => {
			let next = 15;
			try {
				const s = await getJson<StatusResponse>("/api/status");
				if (stopped) return;
				const changed = last.current !== undefined && s.lastIngestAt !== last.current;
				last.current = s.lastIngestAt;
				setLive((prev) => ({ status: s, version: prev.version + (changed ? 1 : 0) }));
				next = s.pollSeconds;
			} catch {
				// The sidebar keeps the last status; the next tick tries again.
			}
			if (!stopped && next > 0) timer = setTimeout(tick, next * 1000);
		};
		void tick();
		return () => {
			stopped = true;
			if (timer) clearTimeout(timer);
		};
	}, []);

	return (
		<RefreshContext.Provider value={refresh}>
			<LiveContext.Provider value={live}>{children}</LiveContext.Provider>
		</RefreshContext.Provider>
	);
}

/** Re-reads the status now (the sidebar updates without waiting for the next poll). */
export const useRefreshStatus = (): (() => void) => useContext(RefreshContext);

/** The latest GET /api/status (null until the first answer). */
export const useStatus = (): StatusResponse | null => useContext(LiveContext).status;

/** How many times new transcript lines have been ingested since the page loaded. */
export const useIngestVersion = (): number => useContext(LiveContext).version;

/** Calls onChange each time lastIngestAt changes (not on the first load). */
export function useLiveRefresh(onChange: () => void): void {
	const version = useIngestVersion();
	const seen = useRef(version);
	const latest = useRef(onChange);
	latest.current = onChange;
	useEffect(() => {
		if (version === seen.current) return;
		seen.current = version;
		latest.current();
	}, [version]);
}

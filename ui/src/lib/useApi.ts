// Fetch hook for one API route: refetches when the path, params or deps change, on reload(), and when live refresh
// reports new ingested lines (keeping the old data on screen while it reloads). Data and errors belong to the URL
// they came from: when the URL changes, the hook returns null until the new response arrives, so a view never shows
// one item's data under another item's selection.
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiErrorClass, buildUrl, getJson, type Params } from "../api";
import { useIngestVersion } from "./useLiveRefresh";

export type ApiState<T> = { data: T | null; error: ApiErrorClass | null; loading: boolean; reload: () => void };

type Held<T> = { url: string | null; data: T | null; error: ApiErrorClass | null; loading: boolean };

export function useApi<T>(path: string | null, params: Params = {}, deps: unknown[] = []): ApiState<T> {
	const url = path === null ? null : buildUrl(path, params);
	const [state, setState] = useState<Held<T>>({ url, data: null, error: null, loading: path !== null });
	const [nonce, setNonce] = useState(0);
	const version = useIngestVersion();
	const request = useRef(0);
	const depsKey = JSON.stringify(deps);

	// biome-ignore lint/correctness/useExhaustiveDependencies: url, depsKey, nonce and version are the triggers
	useEffect(() => {
		if (url === null || path === null) return;
		const id = ++request.current;
		setState((s) => (s.url === url ? { ...s, loading: true } : { url, data: null, error: null, loading: true }));
		getJson<T>(path, params)
			.then((data) => {
				if (id === request.current) setState({ url, data, error: null, loading: false });
			})
			.catch((e: unknown) => {
				if (id !== request.current) return;
				const error = e instanceof ApiErrorClass ? e : new ApiErrorClass("error", String(e), 0);
				setState((s) => ({ url, data: s.url === url ? s.data : null, error, loading: false }));
			});
	}, [url, depsKey, nonce, version]);

	const reload = useCallback(() => setNonce((n) => n + 1), []);
	if (state.url !== url) return { data: null, error: null, loading: url !== null, reload };
	return { data: state.data, error: state.error, loading: state.loading, reload };
}

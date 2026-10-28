// Typed JSON client for the dashboard API. Types come only from src/server/types.ts (alias @api-types).
import type { ApiError } from "@api-types";

export class ApiErrorClass extends Error {
	/** Per-field messages of a 422 from PUT /api/config. */
	fields: { key: string; message: string }[] = [];
	constructor(
		readonly code: string,
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

export type Params = Record<string, string | number | boolean | null | undefined>;

/** path?query with empty values left out, keys in a stable order. */
export function buildUrl(path: string, params: Params = {}): string {
	const q = new URLSearchParams();
	for (const k of Object.keys(params).sort()) {
		const v = params[k];
		if (v === undefined || v === null || v === "" || v === false) continue;
		q.set(k, v === true ? "1" : String(v));
	}
	const s = q.toString();
	return s ? `${path}?${s}` : path;
}

/** GET a JSON route; throws ApiErrorClass with the server's error code (or "network" / "bad_response"). */
export async function getJson<T>(path: string, params: Params = {}): Promise<T> {
	let r: Response;
	try {
		r = await fetch(buildUrl(path, params), { headers: { accept: "application/json" } });
	} catch (e) {
		throw new ApiErrorClass("network", e instanceof Error ? e.message : "The dashboard server is not reachable", 0);
	}
	let body: unknown;
	try {
		body = await r.json();
	} catch {
		throw new ApiErrorClass("bad_response", `Unexpected response (${r.status})`, r.status);
	}
	if (!r.ok) {
		const e = (body as Partial<ApiError>)?.error;
		throw new ApiErrorClass(e?.code ?? "http_error", e?.message ?? `Request failed (${r.status})`, r.status);
	}
	return body as T;
}

/** POST / PUT a JSON body; same errors as getJson. A 422 keeps the body's error fields on the thrown error. */
export async function sendJson<T>(method: "POST" | "PUT", path: string, body: unknown = {}): Promise<T> {
	let r: Response;
	try {
		r = await fetch(path, {
			method,
			headers: { accept: "application/json", "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	} catch (e) {
		throw new ApiErrorClass("network", e instanceof Error ? e.message : "The dashboard server is not reachable", 0);
	}
	let data: unknown;
	try {
		data = await r.json();
	} catch {
		throw new ApiErrorClass("bad_response", `Unexpected response (${r.status})`, r.status);
	}
	if (!r.ok) {
		const e = (data as { error?: { code?: string; message?: string; fields?: { key: string; message: string }[] } })
			?.error;
		const err = new ApiErrorClass(e?.code ?? "http_error", e?.message ?? `Request failed (${r.status})`, r.status);
		err.fields = e?.fields ?? [];
		throw err;
	}
	return data as T;
}

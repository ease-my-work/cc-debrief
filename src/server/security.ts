// Feature 12 server middleware: Host check (DNS rebinding) and Origin / Content-Type check on writes (CSRF).
// No CORS headers are ever sent.
import type { MiddlewareHandler } from "hono";
import type { ApiError } from "./types";

export const apiError = (code: string, message: string): ApiError => ({ error: { code, message } });

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// Browsers leave the default port out of Host and Origin, so on port 80 the bare names are the same site.
const hostsFor = (port: number): string[] =>
	["127.0.0.1", "localhost"].flatMap((h) => (port === 80 ? [`${h}:${port}`, h] : [`${h}:${port}`]));

/** 421 unless Host is exactly 127.0.0.1:<port> or localhost:<port> (or the bare name on port 80). */
export function hostCheck(port: number): MiddlewareHandler {
	const allowed = new Set(hostsFor(port));
	return async (c, next) => {
		const host = c.req.header("host")?.toLowerCase();
		if (!host || !allowed.has(host)) {
			return c.json(apiError("misdirected_request", "Host not allowed: open the dashboard at its 127.0.0.1 URL"), 421);
		}
		await next();
	};
}

/** 403 on a write whose Origin is another site, or whose body is not application/json (forces a preflight). */
export function originCheck(port: number): MiddlewareHandler {
	const origins = new Set(hostsFor(port).map((h) => `http://${h}`));
	return async (c, next) => {
		if (WRITE_METHODS.has(c.req.method)) {
			const origin = c.req.header("origin");
			if (origin !== undefined && !origins.has(origin.toLowerCase())) {
				return c.json(apiError("forbidden_origin", "Cross-origin requests are not allowed"), 403);
			}
			const type = c.req.header("content-type")?.split(";")[0].trim().toLowerCase();
			if (type !== "application/json") {
				return c.json(apiError("unsupported_content_type", "Send the body as application/json"), 403);
			}
		}
		await next();
	};
}

import type { ContentfulStatusCode } from "hono/utils/http-status";

/** Thrown by route handlers: becomes { error: { code, message } } with the status. */
export class HttpError extends Error {
	constructor(
		readonly status: ContentfulStatusCode,
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

// Query-string parsing shared by the routes: zod schemas, 400 bad_request on anything invalid.
import type { Context } from "hono";
import { z } from "zod";
import { HttpError } from "../errors";

export const RangeParam = z.enum(["today", "7d", "30d", "90d", "all"]);
export const SessionTypeParam = z.enum(["feature", "bugfix", "refactor", "exploration", "ops", "docs", "other"]);
export const RepoParam = z.string().min(1).max(500);

/** Parses c.req.query() with the schema; throws HttpError 400 naming the first bad parameter. */
export function parseQuery<T extends z.ZodType>(c: Context, schema: T): z.infer<T> {
	const r = schema.safeParse(c.req.query());
	if (!r.success) {
		const issue = r.error.issues[0];
		const name = issue?.path.join(".") || "query";
		throw new HttpError(400, "bad_request", `Invalid ${name}: ${issue?.message ?? "bad value"}`);
	}
	return r.data;
}

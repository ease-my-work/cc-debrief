// The dashboard server (feature 12): host check → origin / content-type check → /api routes → static UI.
import { Hono } from "hono";
import type { Db } from "../db/adapter";
import { HttpError } from "./errors";
import { registerActivityRoutes } from "./routes/activity";
import { registerConfigRoutes } from "./routes/config";
import { registerCostRoutes } from "./routes/costs";
import { registerFindingRoutes } from "./routes/findings";
import { registerInventoryRoutes } from "./routes/inventory";
import { registerOverviewRoutes } from "./routes/overview";
import { registerPatternRoutes } from "./routes/patterns";
import { registerRecapRoutes } from "./routes/recap";
import { registerRepoRoutes } from "./routes/repos";
import { registerSessionRoutes } from "./routes/sessions";
import { registerTaskRoutes } from "./routes/tasks";
import { apiError, hostCheck, originCheck } from "./security";
import { serveUi } from "./static";

export { HttpError } from "./errors";

export function createApp(db: Db, opts: { port: number; uiDir: string }): Hono {
	const app = new Hono();
	app.use("*", hostCheck(opts.port));
	app.use("*", originCheck(opts.port));

	registerOverviewRoutes(app, db);
	registerSessionRoutes(app, db);
	registerInventoryRoutes(app, db);
	registerRepoRoutes(app, db);
	registerConfigRoutes(app, db);
	registerFindingRoutes(app, db);
	registerPatternRoutes(app, db);
	registerRecapRoutes(app, db);
	registerCostRoutes(app, db);
	registerActivityRoutes(app, db);
	registerTaskRoutes(app, db);

	app.all("/api/*", (c) => c.json(apiError("not_found", `No route ${c.req.method} ${c.req.path}`), 404));
	app.get("*", serveUi(opts.uiDir));
	app.notFound((c) => c.json(apiError("not_found", "Not found"), 404));
	app.onError((err, c) =>
		err instanceof HttpError
			? c.json(apiError(err.code, err.message), err.status)
			: c.json(apiError("internal_error", err instanceof Error ? err.message : String(err)), 500),
	);
	return app;
}

// GET /api/repos, GET /api/repos/:id (Phase 2). No repo filter here (feature 12); the detail's suggestions are the
// repo's repeat patterns (Phase 5b).
import type { Hono } from "hono";
import { z } from "zod";
import { listMemoryFiles, readMemoryFile, validMemoryName } from "../../collector/memory";
import { loadConfig } from "../../config";
import type { Db } from "../../db/adapter";
import { getRepoDetail, listRepos } from "../../db/queries/repos";
import { repoSuggestions } from "../../patterns/views";
import { HttpError } from "../errors";
import type { MemoryFileResponse, MemoryListResponse, RepoDetail, ReposResponse } from "../types";
import { parseQuery, RangeParam } from "./params";

const ReposParams = z.object({ range: RangeParam.default("30d") });

export function registerRepoRoutes(app: Hono, db: Db): void {
	app.get("/api/repos", (c) => {
		const p = parseQuery(c, ReposParams);
		return c.json({ repos: listRepos(db, { ...p, now: new Date() }) } satisfies ReposResponse);
	});
	// Repo ids hold slashes (host/org/repo); the client sends them URL-encoded as one segment.
	app.get("/api/repos/:id", (c) => {
		const p = parseQuery(c, ReposParams);
		const detail = getRepoDetail(db, c.req.param("id"), { ...p, now: new Date() });
		if (!detail) throw new HttpError(404, "not_found", "No such repo");
		return c.json({ ...detail, suggestions: repoSuggestions(db, loadConfig(), detail.repo.id) } satisfies RepoDetail);
	});

	// The repo's auto-memory files (Phase 7 P12): read live from ~/.claude/projects/<slug>/memory, read-only.
	const rootOf = (id: string) => {
		const r = db.prepare("SELECT root_path FROM repos WHERE repo_id = ?").get<{ root_path: string }>(id);
		if (!r) throw new HttpError(404, "not_found", "No such repo");
		return r.root_path;
	};
	app.get("/api/repos/:id/memory", (c) =>
		c.json({ files: listMemoryFiles(rootOf(c.req.param("id"))) } satisfies MemoryListResponse),
	);
	app.get("/api/repos/:id/memory/:name", (c) => {
		const root = rootOf(c.req.param("id"));
		const name = c.req.param("name");
		if (!validMemoryName(name)) throw new HttpError(400, "bad_request", "Invalid memory file name");
		const file = readMemoryFile(root, name);
		if (!file) throw new HttpError(404, "not_found", "No such memory file");
		return c.json({ name, ...file } satisfies MemoryFileResponse);
	});
}

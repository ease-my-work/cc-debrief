// Serves the prebuilt UI from uiDir: files by path, index.html for client routes, 404 for anything else.
// Paths are checked segment by segment and the result must stay inside uiDir.
import { readFileSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import type { Context } from "hono";

const TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json",
	".map": "application/json",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".txt": "text/plain; charset=utf-8",
};

// First path segments the client router handles (feature 12 client routes).
const CLIENT_ROUTES = new Set(["", "activity", "costs", "sessions", "skills", "repos", "recap", "tasks", "settings"]);

function readFile(path: string): Buffer | null {
	try {
		return statSync(path).isFile() ? readFileSync(path) : null;
	} catch {
		return null;
	}
}

/** The decoded path segments of a request, or null when any is unsafe ("..", ".", NUL, a separator). */
function segments(rawPath: string): string[] | null {
	const out: string[] = [];
	for (const raw of rawPath.split("/").slice(1)) {
		let s: string;
		try {
			s = decodeURIComponent(raw);
		} catch {
			return null;
		}
		if (s === "." || s === ".." || s.includes("\0") || s.includes("/") || s.includes("\\")) return null;
		out.push(s);
	}
	return out;
}

export function serveUi(uiDir: string) {
	const root = resolve(uiDir);
	const send = (c: Context, body: Buffer, path: string) =>
		c.body(new Uint8Array(body), 200, {
			"content-type": TYPES[extname(path).toLowerCase()] ?? "application/octet-stream",
			"cache-control": path.endsWith("index.html") ? "no-cache" : "public, max-age=3600",
			"x-content-type-options": "nosniff",
		});
	return (c: Context) => {
		const notFound = () => c.text("Not found", 404);
		const pathname = new URL(c.req.url).pathname;
		// A file only for a path whose every segment is safe; a client route may carry encoded slashes (repo ids).
		const rel = segments(pathname)?.filter((s) => s !== "") ?? null;
		if (rel && rel.length > 0) {
			const file = resolve(join(root, ...rel));
			if (!file.startsWith(root + sep)) return notFound();
			const body = readFile(file);
			if (body) return send(c, body, file);
		}
		if (!CLIENT_ROUTES.has(pathname.split("/")[1] ?? "")) return notFound();
		const index = join(root, "index.html");
		const body = readFile(index);
		return body ? send(c, body, index) : c.text("Dashboard UI not built: run `npm run build`", 404);
	};
}

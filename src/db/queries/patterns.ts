// The patterns table (features 10, 11; Phase 5b spec decisions 2, 5): identity upserts that never touch a row's
// status, the 50%-overlap merge lookup, status changes, and the PatternRow list behind GET /api/patterns.
import type { PatternRow } from "../../server/types";
import type { Db } from "../adapter";

export type PatternKind = PatternRow["kind"];
export type PatternStatus = PatternRow["status"];

/** Kind-specific facts kept in patterns.meta. */
export type PatternMeta = {
	correctionCount?: number;
	corrections?: string[];
	readFiles?: string[];
	testGapPath?: string;
	error?: string | null;
};

export type PatternInput = {
	repoId: string | null;
	label: string;
	labelNorm: string;
	kind: PatternKind;
	sessionIds: string[];
	tokensTotal: number;
	fingerprint: string | null;
	firstSeen: string;
	lastSeen: string;
	meta?: PatternMeta;
};

export type Pattern = PatternInput & {
	id: number;
	meta: PatternMeta;
	status: PatternStatus;
	draftPath: string | null;
	inventoryId: number | null;
	installedAt: string | null;
	dismissedAt: string | null;
};

type Row = {
	id: number;
	repo_id: string | null;
	label: string;
	label_norm: string;
	kind: PatternKind;
	session_ids: string;
	tokens_total: number;
	fingerprint: string | null;
	meta: string;
	first_seen: string;
	last_seen: string;
	status: PatternStatus;
	draft_path: string | null;
	inventory_id: number | null;
	installed_at: string | null;
	dismissed_at: string | null;
};

const COLUMNS = `id, repo_id, label, label_norm, kind, session_ids, tokens_total, fingerprint, meta, first_seen, last_seen,
	status, draft_path, inventory_id, installed_at, dismissed_at`;

const parse = <T>(s: string, fallback: T): T => {
	try {
		return JSON.parse(s) as T;
	} catch {
		return fallback;
	}
};

const toPattern = (r: Row): Pattern => ({
	id: r.id,
	repoId: r.repo_id,
	label: r.label,
	labelNorm: r.label_norm,
	kind: r.kind,
	sessionIds: parse<string[]>(r.session_ids, []),
	tokensTotal: r.tokens_total,
	fingerprint: r.fingerprint,
	meta: parse<PatternMeta>(r.meta, {}),
	firstSeen: r.first_seen,
	lastSeen: r.last_seen,
	status: r.status,
	draftPath: r.draft_path,
	inventoryId: r.inventory_id,
	installedAt: r.installed_at,
	dismissedAt: r.dismissed_at,
});

export function getPattern(db: Db, id: number): Pattern | null {
	const r = db.prepare(`SELECT ${COLUMNS} FROM patterns WHERE id = ?`).get<Row>(id);
	return r ? toPattern(r) : null;
}

/** All patterns, optionally of one repo (`null` = cross-repo) and status, highest tokens first. */
export function listPatternRows(db: Db, opts: { repo?: string | null; status?: PatternStatus } = {}): Pattern[] {
	const where: string[] = [];
	const params: unknown[] = [];
	if (opts.repo !== undefined) {
		where.push("repo_id IS ?");
		params.push(opts.repo);
	}
	if (opts.status) {
		where.push("status = ?");
		params.push(opts.status);
	}
	return db
		.prepare(
			`SELECT ${COLUMNS} FROM patterns ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
			 ORDER BY tokens_total DESC, id`,
		)
		.all<Row>(...params)
		.map(toPattern);
}

/** The feature 12 PatternRow; estDraftUsd is filled by the route (it needs the config). */
export function toPatternRow(p: Pattern, estDraftUsd: number | null = null): PatternRow {
	return {
		id: p.id,
		repoId: p.repoId,
		label: p.label,
		kind: p.kind,
		sessionIds: p.sessionIds,
		sessionCount: p.sessionIds.length,
		tokensTotal: p.tokensTotal,
		fingerprint: p.fingerprint,
		firstSeen: p.firstSeen,
		lastSeen: p.lastSeen,
		status: p.status,
		draftPath: p.draftPath,
		inventoryId: p.inventoryId,
		estDraftUsd,
		correctionCount: p.meta.correctionCount ?? null,
		readFiles: p.meta.readFiles ?? null,
		testGapPath: p.meta.testGapPath ?? null,
		error: p.meta.error ?? null,
	};
}

export function listPatterns(db: Db, opts: { repo?: string | null; status?: PatternStatus } = {}): PatternRow[] {
	return listPatternRows(db, opts).map((p) => toPatternRow(p));
}

/** The pattern with this identity (repo, kind, normalized label), or null. */
export function findPatternByIdentity(
	db: Db,
	repoId: string | null,
	kind: PatternKind,
	labelNorm: string,
): Pattern | null {
	const r = db
		.prepare(`SELECT ${COLUMNS} FROM patterns WHERE COALESCE(repo_id, '') = ? AND kind = ? AND label_norm = ?`)
		.get<Row>(repoId ?? "", kind, labelNorm);
	return r ? toPattern(r) : null;
}

/**
 * An existing row of the repo and kind that shares ≥ 50% of its own session_ids with `sessionIds` (feature 10 step 6:
 * merge into it instead of creating a second candidate for the same task). The largest overlap wins.
 */
export function findOverlappingPattern(
	db: Db,
	repoId: string | null,
	kind: PatternKind,
	sessionIds: string[],
): Pattern | null {
	const wanted = new Set(sessionIds);
	let best: { p: Pattern; share: number } | null = null;
	for (const p of listPatternRows(db, { repo: repoId }).filter((x) => x.kind === kind)) {
		if (p.sessionIds.length === 0) continue;
		const share = p.sessionIds.filter((id) => wanted.has(id)).length / p.sessionIds.length;
		if (share >= 0.5 && (!best || share > best.share)) best = { p, share };
	}
	return best?.p ?? null;
}

/**
 * Inserts a candidate, or updates an existing row's detection fields (never its status, draft, install or dismissal)
 * only when one of them changed. Pass `id` to update that row (an overlap merge). Returns the id and what happened.
 */
export function upsertPattern(
	db: Db,
	p: PatternInput & { id?: number },
): { id: number; created: boolean; updated: boolean } {
	const existing = p.id !== undefined ? getPattern(db, p.id) : findPatternByIdentity(db, p.repoId, p.kind, p.labelNorm);
	const sessionIds = JSON.stringify(p.sessionIds);
	const meta = JSON.stringify(p.meta ?? {});
	if (!existing) {
		const r = db
			.prepare(
				`INSERT INTO patterns (repo_id, label, label_norm, kind, session_ids, tokens_total, fingerprint, meta, first_seen, last_seen)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				p.repoId,
				p.label,
				p.labelNorm,
				p.kind,
				sessionIds,
				p.tokensTotal,
				p.fingerprint,
				meta,
				p.firstSeen,
				p.lastSeen,
			);
		return { id: Number(r.lastInsertRowid), created: true, updated: false };
	}
	// The draft error survives detection; detection's own facts replace the rest.
	const mergedMeta = JSON.stringify({
		...(p.meta ?? {}),
		...(existing.meta.error ? { error: existing.meta.error } : {}),
	});
	const same =
		existing.label === p.label &&
		existing.labelNorm === p.labelNorm &&
		JSON.stringify(existing.sessionIds) === sessionIds &&
		existing.tokensTotal === p.tokensTotal &&
		existing.fingerprint === p.fingerprint &&
		JSON.stringify(existing.meta) === mergedMeta &&
		existing.firstSeen === p.firstSeen &&
		existing.lastSeen === p.lastSeen;
	if (same) return { id: existing.id, created: false, updated: false };
	db.prepare(
		`UPDATE patterns SET label = ?, label_norm = ?, session_ids = ?, tokens_total = ?, fingerprint = ?, meta = ?,
		 first_seen = ?, last_seen = ? WHERE id = ?`,
	).run(
		p.label,
		p.labelNorm,
		sessionIds,
		p.tokensTotal,
		p.fingerprint,
		mergedMeta,
		p.firstSeen,
		p.lastSeen,
		existing.id,
	);
	return { id: existing.id, created: false, updated: true };
}

/**
 * Moves a pattern to a status: installed sets installed_at (and the inventory link), dismissed sets dismissed_at,
 * candidate clears dismissed_at; draftPath / inventoryId are set when given.
 */
export function setPatternStatus(
	db: Db,
	id: number,
	status: PatternStatus,
	fields: { draftPath?: string | null; inventoryId?: number | null; now?: Date } = {},
): void {
	const now = (fields.now ?? new Date()).toISOString();
	const sets = ["status = ?"];
	const params: unknown[] = [status];
	if (status === "installed") {
		sets.push("installed_at = ?");
		params.push(now);
	}
	if (status === "dismissed") {
		sets.push("dismissed_at = ?");
		params.push(now);
	}
	if (status === "candidate") sets.push("dismissed_at = NULL");
	if (fields.draftPath !== undefined) {
		sets.push("draft_path = ?");
		params.push(fields.draftPath);
	}
	if (fields.inventoryId !== undefined) {
		sets.push("inventory_id = ?");
		params.push(fields.inventoryId);
	}
	db.prepare(`UPDATE patterns SET ${sets.join(", ")} WHERE id = ?`).run(...params, id);
}

/** Sets or clears the last draft error shown on the card (feature 11 edge cases). */
export function setPatternError(db: Db, id: number, error: string | null): void {
	const p = getPattern(db, id);
	if (!p) return;
	db.prepare("UPDATE patterns SET meta = ? WHERE id = ?").run(JSON.stringify({ ...p.meta, error }), id);
}

export function deletePattern(db: Db, id: number): void {
	db.prepare("DELETE FROM patterns WHERE id = ?").run(id);
}

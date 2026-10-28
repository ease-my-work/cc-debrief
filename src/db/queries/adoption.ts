// Feature adoption and Claude Code versions (Phase 7 P10, feature 03; spec decision 10). Shares are of sessions
// started in the range (and repo): plan mode = permission_mode 'plan' at start or an EnterPlanMode call (one session
// counts once); subagents = a subagents row; skills = a Skill call or an invoked skill; MCP = any MCP call; web =
// WebFetch / WebSearch; auto mode = permission_mode 'auto'.
import type { AdoptionRow, Range, VersionRow } from "../../server/types";
import type { Db } from "../adapter";
import { rangeStart } from "./range";

const FEATURES: { feature: AdoptionRow["feature"]; where: string }[] = [
	{
		feature: "plan_mode",
		where: `s.permission_mode = 'plan'
		  OR EXISTS (SELECT 1 FROM tool_calls t WHERE t.session_id = s.session_id AND t.tool_name = 'EnterPlanMode')`,
	},
	{ feature: "subagents", where: "EXISTS (SELECT 1 FROM subagents a WHERE a.session_id = s.session_id)" },
	{
		feature: "skills",
		where: `EXISTS (SELECT 1 FROM tool_calls t WHERE t.session_id = s.session_id AND t.tool_name = 'Skill')
		  OR EXISTS (SELECT 1 FROM inventory_usage u JOIN inventory i ON i.id = u.inventory_id
		    WHERE u.session_id = s.session_id AND u.invoked = 1 AND i.kind = 'skill')`,
	},
	{
		feature: "mcp",
		where: "EXISTS (SELECT 1 FROM tool_calls t WHERE t.session_id = s.session_id AND t.mcp_server IS NOT NULL)",
	},
	{
		feature: "web",
		where: `EXISTS (SELECT 1 FROM tool_calls t WHERE t.session_id = s.session_id
		  AND t.tool_name IN ('WebFetch', 'WebSearch'))`,
	},
	{ feature: "auto_mode", where: "s.permission_mode = 'auto'" },
];

export function getAdoption(db: Db, opts: { range: Range; repo?: string; now: Date }): AdoptionRow[] {
	const scope = `s.started_at >= ?${opts.repo ? " AND s.repo_id = ?" : ""}`;
	const params = [rangeStart(opts.range, opts.now), ...(opts.repo ? [opts.repo] : [])];
	const cols = FEATURES.map((f, i) => `sum(CASE WHEN ${f.where} THEN 1 ELSE 0 END) AS f${i}`).join(", ");
	const row = db
		.prepare(`SELECT count(*) AS total, ${cols} FROM sessions s WHERE ${scope}`)
		.get<Record<string, number | null>>(...params) ?? { total: 0 };
	const total = row.total ?? 0;
	return FEATURES.map((f, i) => {
		const sessions = row[`f${i}`] ?? 0;
		return { feature: f.feature, sessions, share: total > 0 ? sessions / total : 0 };
	});
}

/** Numeric compare of dotted versions (2.1.10 after 2.1.9); non-numeric parts compare as text. */
function compareVersions(a: string, b: string): number {
	const pa = a.split(/[.-]/);
	const pb = b.split(/[.-]/);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const x = pa[i] ?? "";
		const y = pb[i] ?? "";
		const nx = Number(x);
		const ny = Number(y);
		const d = Number.isInteger(nx) && Number.isInteger(ny) && x !== "" && y !== "" ? nx - ny : x.localeCompare(y);
		if (d !== 0) return d;
	}
	return 0;
}

/** Every Claude Code version seen in retained sessions, newest version first. */
export function getVersions(db: Db): VersionRow[] {
	return db
		.prepare(
			`SELECT cc_version AS version, min(started_at) AS firstSeen, max(started_at) AS lastSeen, count(*) AS sessions
			 FROM sessions WHERE cc_version IS NOT NULL AND started_at IS NOT NULL GROUP BY cc_version`,
		)
		.all<VersionRow>()
		.sort((a, b) => compareVersions(b.version, a.version));
}

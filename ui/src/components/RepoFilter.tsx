import type { ReposResponse } from "@api-types";
import { useApi } from "../lib/useApi";

/** "All repos" dropdown: the repos with sessions in the last 30 days. */
export function RepoFilter({ value, onChange }: { value: string | null; onChange: (repo: string | null) => void }) {
	const { data } = useApi<ReposResponse>("/api/repos", { range: "30d" });
	const repos = data?.repos ?? [];
	return (
		<select
			aria-label="Repo"
			value={value ?? ""}
			onChange={(e) => onChange(e.target.value || null)}
			className="max-w-[220px] rounded-lg border border-border bg-panel px-3 py-1.5 text-[13px] text-ink"
		>
			<option value="">All repos</option>
			{value && !repos.some((r) => r.id === value) ? <option value={value}>{value}</option> : null}
			{repos.map((r) => (
				<option key={r.id} value={r.id}>
					{r.name}
				</option>
			))}
		</select>
	);
}

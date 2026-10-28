// Repos (feature 12; mockup Repos.html): range dropdown only (no repo filter), the repo table, and for the selected
// repo (URL /repos/:id) its most edited files, repo-level skills & MCP, and its repeated-work suggestions (Phase 5b).
import type { RepoDetail, ReposResponse } from "@api-types";
import { useLocation, useSearch } from "wouter";
import { EmptyState } from "../components/EmptyState";
import { ErrorCard } from "../components/ErrorCard";
import { MemoryFiles } from "../components/MemoryFiles";
import { MostEditedFiles } from "../components/MostEditedFiles";
import { RangeSelect } from "../components/RangeSelect";
import { RepoItems } from "../components/RepoItems";
import { RepoTable } from "../components/RepoTable";
import { RepoTrends } from "../components/RepoTrends";
import { SkeletonCard } from "../components/Skeleton";
import { SuggestionsPanel } from "../components/SuggestionsPanel";
import { TopBar } from "../components/TopBar";
import { useApi } from "../lib/useApi";
import { useRange } from "../lib/useFilters";
import { useStatus } from "../lib/useLiveRefresh";

function decode(id: string | undefined): string | null {
	if (!id) return null;
	try {
		return decodeURIComponent(id);
	} catch {
		return id;
	}
}

export function Repos({ id }: { id?: string }) {
	const selected = decode(id);
	const [range, setRange] = useRange("repos", "30d");
	const [, navigate] = useLocation();
	const search = useSearch();
	const status = useStatus();
	const list = useApi<ReposResponse>("/api/repos", { range });
	const detail = useApi<RepoDetail>(selected ? `/api/repos/${encodeURIComponent(selected)}` : null, { range });

	const top = (
		<TopBar title="Repos">
			<RangeSelect value={range} onChange={setRange} />
		</TopBar>
	);
	if (list.error && !list.data) {
		return (
			<>
				{top}
				<ErrorCard error={list.error} onRetry={list.reload} />
			</>
		);
	}
	if (!list.data) {
		return (
			<>
				{top}
				<SkeletonCard height={220} />
			</>
		);
	}
	if (list.data.repos.length === 0) {
		return (
			<>
				{top}
				{status?.lastIngestAt === null ? (
					<EmptyState />
				) : (
					<EmptyState
						title="No repos in this range"
						hint="Sessions outside a git repo are not listed here."
						command={null}
					/>
				)}
			</>
		);
	}

	return (
		<>
			{top}
			<RepoTable
				repos={list.data.repos}
				selected={selected}
				onSelect={(rid) => navigate(`/repos/${encodeURIComponent(rid)}${search ? `?${search}` : ""}`)}
			/>
			{selected ? (
				detail.error ? (
					<ErrorCard error={detail.error} onRetry={detail.reload} />
				) : detail.data ? (
					<>
						<RepoTrends d={detail.data} />
						<div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
							<MostEditedFiles d={detail.data} />
							<RepoItems d={detail.data} />
							<SuggestionsPanel
								repoId={detail.data.repo.id}
								suggestions={detail.data.suggestions}
								draftsEnabled={status?.ai.drafts ?? false}
								onChanged={detail.reload}
							/>
						</div>
						<MemoryFiles repoId={detail.data.repo.id} />
					</>
				) : (
					<SkeletonCard height={220} />
				)
			) : null}
		</>
	);
}

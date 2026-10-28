// Repos "Repeated work · suggestions" (features 10-12; mockup Repos.html): the selected repo's pattern cards with an
// accent border, test gaps as single lines last.
import type { PatternRow } from "@api-types";
import { Link } from "wouter";
import { PatternCard } from "./PatternCard";

export function SuggestionsPanel({
	repoId,
	suggestions,
	draftsEnabled,
	onChanged,
}: {
	repoId: string;
	suggestions: PatternRow[];
	draftsEnabled: boolean;
	onChanged: () => void;
}) {
	return (
		<section
			className="card flex flex-col gap-2.5 px-4 py-3.5"
			style={{ borderColor: "#C9D3F5" }}
			aria-label="Repeated work · suggestions"
		>
			<div className="flex items-center">
				<div className="section-h flex-grow">Repeated work · suggestions</div>
				<Link href={`/sessions?repo=${encodeURIComponent(repoId)}`} className="text-[12.5px] font-medium no-underline">
					Recent sessions
				</Link>
			</div>
			{suggestions.length === 0 ? (
				<p className="m-0 text-[13px] text-muted">No repeated work found in the last 30 days.</p>
			) : (
				suggestions.map((p) => <PatternCard key={p.id} p={p} draftsEnabled={draftsEnabled} onChanged={onChanged} />)
			)}
		</section>
	);
}

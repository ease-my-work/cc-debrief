// Redaction patterns (features 14, 16): the built-in set as one locked row that can be removed or restored, custom
// rows, an add input, and a Test box that runs the same rules as capture (src/redact.ts through the @redact alias).
import { compilePattern, redact } from "@redact";
import { useState } from "react";

const DEFAULT = "@default";

export function RedactList({
	patterns,
	defaultCount,
	onSave,
}: {
	patterns: string[];
	defaultCount: number;
	onSave: (next: string[]) => Promise<string | null>;
}) {
	const [draft, setDraft] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [sample, setSample] = useState("");
	const hasDefault = patterns.includes(DEFAULT);
	const custom = patterns.filter((p) => p !== DEFAULT);

	const save = async (next: string[]) => setError(await onSave(next));
	const add = async () => {
		const p = draft.trim();
		if (!p) return;
		if (compilePattern(p) === null) {
			setError("Not a valid regular expression");
			return;
		}
		if (patterns.includes(p)) {
			setDraft("");
			return;
		}
		const message = await onSave([...patterns, p]);
		setError(message);
		if (!message) setDraft("");
	};

	return (
		<div className="flex flex-col gap-2">
			<div
				className={`flex items-center gap-2.5 rounded-lg border border-border px-2.5 py-1.5 text-[13px] ${hasDefault ? "bg-band" : "bg-panel opacity-70"}`}
			>
				<svg
					width="14"
					height="14"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					aria-hidden="true"
					className="text-muted"
				>
					<rect x="5" y="11" width="14" height="10" rx="2" />
					<path d="M8 11V7a4 4 0 0 1 8 0v4" />
				</svg>
				<span className="flex-grow">
					Built-in secret patterns <span className="mono text-muted">({defaultCount})</span>
					{hasDefault ? null : <span className="ml-2 text-[12px] text-bad">off</span>}
				</span>
				<button
					type="button"
					aria-label={hasDefault ? "Remove built-in secret patterns" : "Restore built-in secret patterns"}
					onClick={() => save(hasDefault ? custom : [DEFAULT, ...custom])}
					className="border-0 bg-transparent p-0 text-[12.5px] font-medium text-accent"
				>
					{hasDefault ? "Remove" : "Restore"}
				</button>
			</div>
			{custom.map((p) => (
				<div key={p} className="flex items-center gap-2.5 rounded-lg border border-border bg-panel px-2.5 py-1.5">
					<span className="mono flex-grow break-all text-[12.5px]">{p}</span>
					<button
						type="button"
						aria-label={`Remove pattern ${p}`}
						onClick={() => save(patterns.filter((x) => x !== p))}
						className="flex h-[22px] w-[22px] items-center justify-center rounded border-0 bg-transparent p-0 text-muted"
					>
						<svg
							width="13"
							height="13"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2.5"
							aria-hidden="true"
						>
							<path d="M6 6l12 12M18 6 6 18" />
						</svg>
					</button>
				</div>
			))}
			<div className="flex gap-2">
				<input
					aria-label="Add a pattern"
					placeholder="Add a pattern: regex or /body/flags"
					value={draft}
					onChange={(e) => {
						setDraft(e.target.value);
						setError(null);
					}}
					onKeyDown={(e) => {
						if (e.key === "Enter") void add();
					}}
					className="mono min-w-0 flex-grow rounded-md border border-border bg-panel px-2 py-1.5 text-[12.5px] text-ink"
				/>
				<button
					type="button"
					onClick={add}
					className="rounded-md border border-border bg-panel px-2.5 py-1 text-[12.5px] font-medium text-ink"
				>
					Add
				</button>
			</div>
			{error ? <span className="text-[12px] text-bad">{error}</span> : null}
			{hasDefault ? null : (
				<span className="text-[12px] text-amber">
					Without the built-in patterns, API keys and tokens are stored as typed.
				</span>
			)}
			<div className="overflow-hidden rounded-lg border border-border">
				<label
					className="block border-b border-row bg-band px-2.5 py-1.5 text-[12px] text-muted"
					htmlFor="redact-sample"
				>
					Test against sample text
				</label>
				<textarea
					id="redact-sample"
					aria-label="Sample text"
					rows={2}
					value={sample}
					onChange={(e) => setSample(e.target.value)}
					placeholder="Paste text with a secret in it"
					className="mono block w-full resize-y border-0 border-b border-row bg-panel px-2.5 py-2 text-[12.5px] text-ink"
				/>
				<output className="mono block min-h-[1.5em] px-2.5 py-2 text-[12.5px] break-all" aria-label="Redacted sample">
					{sample ? redact(sample, patterns) : ""}
				</output>
			</div>
		</div>
	);
}

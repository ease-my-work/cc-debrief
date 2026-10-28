// Session timeline (feature 12): per turn the prompt, tool chips, subagent chips and the assistant excerpt; a
// compaction marker between turns; "N more turns…" after the first two.
import type { SessionDetail } from "@api-types";
import { useState } from "react";
import { ToolChip } from "./ToolChip";

const PROMPT_MAX = 600;

function Prompt({ text }: { text: string }) {
	const [open, setOpen] = useState(false);
	const long = text.length > PROMPT_MAX;
	return (
		<div className="text-[13.5px] leading-normal break-words whitespace-pre-wrap">
			<span className="text-muted">You · </span>
			{long && !open ? `${text.slice(0, PROMPT_MAX)}…` : text}
			{long ? (
				<button
					type="button"
					onClick={() => setOpen(!open)}
					className="ml-1 border-0 bg-transparent p-0 text-[12px] text-accent"
				>
					{open ? "less" : "more"}
				</button>
			) : null}
		</div>
	);
}

export function Timeline({ d, onReplay }: { d: SessionDetail; onReplay?: () => void }) {
	const [all, setAll] = useState(false);
	const shown = all ? d.turns : d.turns.slice(0, 2);
	return (
		<div className="flex flex-col gap-3.5 px-5 py-3.5">
			<div className="flex items-center gap-2">
				<div className="section-h flex-grow">
					Timeline · {d.turns.length} turns · {d.toolCallCount} tool calls
				</div>
				{onReplay ? (
					<button type="button" onClick={onReplay} className="border-0 bg-transparent p-0 text-[12px] text-accent">
						Full replay
					</button>
				) : null}
			</div>
			{shown.map((t, i) => {
				const agents = d.subagents.filter((a) => a.turnSeq === t.seq);
				return (
					<div key={t.seq} className="flex flex-col gap-3">
						<div className="flex gap-3">
							<div className="flex w-2 flex-col items-center pt-1.5">
								<div className="h-2 w-2 rounded-full bg-ink" />
								{i < shown.length - 1 ? <div className="mt-1 w-px flex-grow bg-border" /> : null}
							</div>
							<div className="flex min-w-0 flex-grow flex-col gap-2">
								<Prompt text={t.userText} />
								{t.tools.length > 0 || agents.length > 0 ? (
									<div className="flex flex-wrap gap-1.5">
										{t.tools.map((tool) => (
											<ToolChip key={tool.label} tool={tool} />
										))}
										{agents.map((a) => (
											<span
												key={a.agentId}
												title={a.description ?? undefined}
												className="mono inline-block rounded-md bg-accent-fill px-2 py-0.5 text-[12px] text-accent"
											>
												subagent: {a.agentType ?? "agent"}
											</span>
										))}
									</div>
								) : null}
								{t.assistantExcerpt ? (
									<div className="text-[13px] leading-normal text-muted">{t.assistantExcerpt}</div>
								) : null}
							</div>
						</div>
						{d.compactions
							.filter((c) => c.afterTurnSeq === t.seq)
							.map((c) => (
								<div key={c.ts} className="flex items-center gap-2 text-[12px] text-muted">
									<span className="h-px flex-grow bg-border" />
									Compacted · {c.trigger ?? "auto"}
									<span className="h-px flex-grow bg-border" />
								</div>
							))}
					</div>
				);
			})}
			{!all && d.turns.length > 2 ? (
				<button
					type="button"
					onClick={() => setAll(true)}
					className="self-start border-0 bg-transparent p-0 text-[12px] text-accent"
				>
					{d.turns.length - 2} more turns…
				</button>
			) : null}
		</div>
	);
}

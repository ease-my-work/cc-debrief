// Side facts (feature 12): tokens with cost in bold (or "tokens unknown"), files with +N, and "Used": skills, MCP
// servers and tools with call counts and failures, then instruction files.
import type { SessionDetail, UsedItem } from "@api-types";
import { useState } from "react";
import { compactTokens, num, signed, usd } from "../lib/format";

const FILES_SHOWN = 5;

function Kv({ k, v, bold = false }: { k: string; v: string; bold?: boolean }) {
	return (
		<div className={`flex justify-between py-0.5 text-[13px] ${bold ? "font-semibold" : ""}`}>
			<span className={bold ? "" : "text-muted"}>{k}</span>
			<span className="mono">{v}</span>
		</div>
	);
}

const base = (p: string) => p.split(/[\\/]/).pop() ?? p;

/** "Bash ×5 · 2 failed"; the count only above 1, failures only when there are some. */
const usedText = (u: UsedItem) =>
	`${u.name}${u.calls > 1 ? ` ×${u.calls}` : ""}${u.failures > 0 ? ` · ${u.failures} failed` : ""}`;

function UsedGroup({ label, items }: { label: string; items: { text: string; failed: boolean }[] }) {
	if (items.length === 0) return null;
	return (
		<div className="flex flex-col gap-1">
			<div className="text-[12px] text-muted">{label}</div>
			<div className="flex flex-wrap gap-1.5">
				{items.map((u) => (
					<span
						key={u.text}
						title={u.text}
						className={`badge mono max-w-full truncate ${u.failed ? "bg-bad-fill text-bad" : "bg-neutral-fill text-neutral-text"}`}
					>
						{u.text}
					</span>
				))}
			</div>
		</div>
	);
}

export function SideFacts({ d }: { d: SessionDetail }) {
	const [allFiles, setAllFiles] = useState(false);
	const added = d.files.reduce((n, f) => n + f.added, 0);
	const removed = d.files.reduce((n, f) => n + f.removed, 0);
	const files = allFiles ? d.files : d.files.slice(0, FILES_SHOWN);
	// Name the repo only when the session edited more than one: the same relative path can be in each.
	const manyRepos = new Set(d.files.map((f) => f.repo)).size > 1;
	const fileLabel = (f: SessionDetail["files"][number]) => (manyRepos && f.repo ? `${f.repo}/${f.path}` : f.path);
	const items = (xs: UsedItem[]) => xs.map((u) => ({ text: usedText(u), failed: u.failures > 0 }));
	const groups = [
		{ label: "Skills", items: items(d.used.skills) },
		{ label: "MCP", items: items(d.used.mcpServers) },
		{ label: "Tools", items: items(d.used.tools) },
		{
			label: "Instructions",
			items: d.used.instructionFiles.map((f) => ({
				text: `${base(f.path)}${f.count > 1 ? ` ×${f.count}` : ""}`,
				failed: false,
			})),
		},
	];
	return (
		<div className="flex flex-col gap-4 border-l border-row px-[18px] py-3.5">
			<div>
				<div className="section-h mb-1.5">Tokens</div>
				{d.tokens.unknown ? (
					<p className="m-0 text-[13px] text-muted">tokens unknown</p>
				) : (
					<>
						<Kv k="Input" v={compactTokens(d.tokens.input)} />
						<Kv k="Cache write" v={compactTokens(d.tokens.cacheWrite)} />
						<Kv k="Cache read" v={compactTokens(d.tokens.cacheRead)} />
						<Kv k="Output" v={compactTokens(d.tokens.output)} />
						<Kv k="Cost" v={usd(d.tokens.costUsd)} bold />
					</>
				)}
			</div>
			{d.files.length > 0 ? (
				<div>
					<div className="section-h mb-1.5">
						Files · {signed(added, "+")} {signed(removed, "-")}
					</div>
					{files.map((f) => (
						<div key={`${f.repo ?? ""}/${f.path}`} className="flex justify-between gap-2 py-0.5 text-[12.5px]">
							<span className="mono truncate" title={fileLabel(f)}>
								{fileLabel(f)}
							</span>
							<span className="mono text-good">+{num(f.added)}</span>
						</div>
					))}
					{!allFiles && d.files.length > FILES_SHOWN ? (
						<button
							type="button"
							onClick={() => setAllFiles(true)}
							className="border-0 bg-transparent p-0 text-[12px] text-accent"
						>
							{d.files.length - FILES_SHOWN} more files
						</button>
					) : null}
				</div>
			) : null}
			{groups.some((g) => g.items.length > 0) ? (
				<section aria-label="Used" className="flex flex-col gap-2">
					<div className="section-h">Used</div>
					{groups.map((g) => (
						<UsedGroup key={g.label} label={g.label} items={g.items} />
					))}
				</section>
			) : null}
		</div>
	);
}

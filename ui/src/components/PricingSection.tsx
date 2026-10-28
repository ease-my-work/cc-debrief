// Settings "Pricing" (Phase 7 P7, features 02 and 16): the built-in table's date and rows, the user's overrides
// (pricing.overrides in config.json) with add and remove, and the re-price job's progress.
import type { ConfigPatch, ConfigResponse } from "@api-types";
import { useState } from "react";
import { num } from "../lib/format";

type Override = { input: number; output: number; cacheWrite?: number; cacheWrite1h?: number; cacheRead?: number };

const field = "mono w-[72px] rounded-md border border-border bg-panel px-2 py-1 text-[13px] text-ink";
const button = "rounded-md border border-border bg-panel px-2.5 py-1 text-[12.5px] font-medium text-ink";
const price = (n: number | undefined) => (n === undefined ? "—" : `$${Number(n.toFixed(4))}`);

export function PricingSection({
	pricing,
	overrides,
	save,
}: {
	pricing: ConfigResponse["pricing"];
	overrides: Record<string, Override>;
	save: (patch: ConfigPatch) => Promise<string | null>;
}) {
	const [model, setModel] = useState("");
	const [input, setInput] = useState("");
	const [output, setOutput] = useState("");
	const [message, setMessage] = useState<string | null>(null);

	const add = async () => {
		const key = model.trim();
		const i = Number(input);
		const o = Number(output);
		if (!key) return setMessage("Name a model id or a family (opus, sonnet, haiku).");
		if (input.trim() === "" || output.trim() === "" || !Number.isFinite(i) || !Number.isFinite(o))
			return setMessage("Prices must be numbers of dollars per million tokens.");
		const error = await save({ set: { [`pricing.overrides.${key}`]: { input: i, output: o } } });
		setMessage(error);
		if (!error) {
			setModel("");
			setInput("");
			setOutput("");
		}
	};

	const rows = Object.entries(overrides);
	return (
		<section className="card" aria-labelledby="pricing-h">
			<div className="px-[18px] pt-3.5 pb-1">
				<h2 id="pricing-h" className="section-h m-0">
					Pricing
				</h2>
				<p className="m-0 mt-0.5 text-[12.5px] text-muted">
					Built-in prices as of {pricing.tableVersion}, in dollars per million tokens. Overrides re-price the sessions
					the tracker counted itself; sessions with Claude Code's cost line keep Claude Code's own cost.
				</p>
			</div>
			{pricing.repricing ? (
				<div className="border-t border-row px-[18px] py-2.5 text-[12.5px] text-amber" role="status">
					Re-pricing {num(pricing.repricing.total)} sessions ({num(pricing.repricing.done)} done)
				</div>
			) : null}
			<div className="border-t border-row px-[18px] py-3">
				<div className="mb-1.5 text-[14px] font-medium">Your overrides</div>
				{rows.length === 0 ? (
					<p className="m-0 text-[12.5px] text-muted">None: every cost uses the built-in table.</p>
				) : (
					<table className="w-full text-[13px]">
						<thead>
							<tr className="text-left text-[12px] text-muted">
								<th className="py-1 font-semibold">Model or family</th>
								<th className="py-1 text-right font-semibold">Input</th>
								<th className="py-1 text-right font-semibold">Output</th>
								<th className="py-1 text-right font-semibold">Cache read</th>
								<th />
							</tr>
						</thead>
						<tbody>
							{rows.map(([key, o]) => (
								<tr key={key} className="border-t border-row">
									<td className="mono py-1.5">{key}</td>
									<td className="mono py-1.5 text-right">{price(o.input)}</td>
									<td className="mono py-1.5 text-right">{price(o.output)}</td>
									<td className="mono py-1.5 text-right">{price(o.cacheRead ?? o.input * 0.1)}</td>
									<td className="py-1.5 text-right">
										<button
											type="button"
											className={button}
											aria-label={`Remove override ${key}`}
											onClick={async () => setMessage(await save({ unset: [`pricing.overrides.${key}`] }))}
										>
											Remove
										</button>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
				<div className="mt-2.5 flex flex-wrap items-center gap-2 text-[12.5px] text-muted">
					<input
						aria-label="Model or family"
						placeholder="opus or claude-opus-5-5"
						value={model}
						onChange={(e) => setModel(e.target.value)}
						className="mono w-[180px] rounded-md border border-border bg-panel px-2 py-1 text-[13px] text-ink"
					/>
					in
					<input
						aria-label="Input $/M"
						inputMode="decimal"
						value={input}
						onChange={(e) => setInput(e.target.value)}
						className={field}
					/>
					out
					<input
						aria-label="Output $/M"
						inputMode="decimal"
						value={output}
						onChange={(e) => setOutput(e.target.value)}
						className={field}
					/>
					<button type="button" className={button} onClick={() => void add()}>
						Add override
					</button>
				</div>
				{message ? <div className="mt-1.5 text-[12px] text-bad">{message}</div> : null}
			</div>
			<details className="border-t border-row px-[18px] py-3">
				<summary className="cursor-pointer text-[13.5px] font-medium">Built-in table</summary>
				<table className="mt-2 w-full text-[12.5px]">
					<thead>
						<tr className="text-left text-[12px] text-muted">
							<th className="py-1 font-semibold">Model</th>
							<th className="py-1 text-right font-semibold">Input</th>
							<th className="py-1 text-right font-semibold">Output</th>
							<th className="py-1 text-right font-semibold">Cache write</th>
							<th className="py-1 text-right font-semibold">Cache read</th>
						</tr>
					</thead>
					<tbody>
						{pricing.builtIn.map((p) => (
							<tr key={p.model} className="border-t border-row">
								<td className="mono py-1">{p.model}</td>
								<td className="mono py-1 text-right">{price(p.input)}</td>
								<td className="mono py-1 text-right">{price(p.output)}</td>
								<td className="mono py-1 text-right">{price(p.cacheWrite)}</td>
								<td className="mono py-1 text-right">{price(p.cacheRead)}</td>
							</tr>
						))}
					</tbody>
				</table>
			</details>
		</section>
	);
}

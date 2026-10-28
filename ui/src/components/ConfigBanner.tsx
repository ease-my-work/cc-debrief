// The banner over the Settings page while config.json has invalid keys (feature 16): defaults are in use for them.
import type { ConfigIssue } from "@api-types";

export function ConfigBanner({ errors, path }: { errors: ConfigIssue[]; path: string }) {
	if (errors.length === 0) return null;
	return (
		<div role="alert" className="card flex items-start gap-3 border-transparent bg-bad-fill px-4 py-3 text-bad">
			<svg
				width="18"
				height="18"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="2"
				aria-hidden="true"
			>
				<path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
			</svg>
			<div className="text-[13.5px] leading-normal">
				<p className="m-0 font-semibold">
					config.json has {errors.length} invalid {errors.length === 1 ? "key" : "keys"}; defaults are used for{" "}
					{errors.length === 1 ? "it" : "them"} until you fix {errors.length === 1 ? "it" : "them"} here or in{" "}
					<span className="mono">{path}</span>
				</p>
				<ul className="m-0 mt-1 list-none p-0">
					{errors.map((e) => (
						<li key={e.key}>
							<span className="mono">{e.key}</span> {e.message}
						</li>
					))}
				</ul>
			</div>
		</div>
	);
}

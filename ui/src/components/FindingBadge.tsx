// A finding's rule label as a pill, coloured by severity (feature 07: high red, medium amber, low blue).
import type { ReviewBand } from "@api-types";

type Severity = ReviewBand["findings"][number]["severity"];

const COLOURS: Record<Severity, { background: string; color: string }> = {
	high: { background: "#FCEBE7", color: "#9B3A24" },
	medium: { background: "#FBF1DC", color: "#7A5410" },
	low: { background: "#E7EEFF", color: "#26409A" },
};

export function FindingBadge({ label, severity }: { label: string; severity: Severity }) {
	return (
		<span className="badge shrink-0" style={COLOURS[severity]} title={`${severity} severity`}>
			{label}
		</span>
	);
}

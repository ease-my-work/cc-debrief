// The capture.* settings the hook reads on every run, without zod or the full config schema, so the hook bundle
// stays small (src/config.ts re-exports loadCaptureConfig and builds its schema from these constants).
import { readFileSync } from "node:fs";
import { configPath } from "./paths";

export type CaptureConfig = { redact: string[]; maxFieldBytes: number; permissionHook: boolean };

export const CAPTURE_DEFAULTS: CaptureConfig = { redact: ["@default"], maxFieldBytes: 32768, permissionHook: true };
export const MAX_FIELD_BYTES = { min: 1024, max: 1_048_576 };
export const MAX_LIST = 200;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Hook fast path: plain JSON and type checks for capture.*, defaults on any problem; never throws. */
export function loadCaptureConfig(): CaptureConfig {
	const d = { ...CAPTURE_DEFAULTS, redact: [...CAPTURE_DEFAULTS.redact] };
	try {
		const c: unknown = JSON.parse(readFileSync(configPath(), "utf8"))?.capture;
		if (!isObject(c)) return d;
		const { redact, maxFieldBytes, permissionHook } = c;
		return {
			redact:
				Array.isArray(redact) && redact.length <= MAX_LIST && redact.every((p) => typeof p === "string")
					? redact
					: d.redact,
			maxFieldBytes:
				Number.isInteger(maxFieldBytes) &&
				(maxFieldBytes as number) >= MAX_FIELD_BYTES.min &&
				(maxFieldBytes as number) <= MAX_FIELD_BYTES.max
					? (maxFieldBytes as number)
					: d.maxFieldBytes,
			permissionHook: typeof permissionHook === "boolean" ? permissionHook : d.permissionHook,
		};
	} catch {
		return d;
	}
}

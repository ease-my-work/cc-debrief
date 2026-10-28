// Redaction and field capping (feature 14). Runs before anything is stored.

// Verbatim from docs/features/14-local-only-privacy.md; scripts/lib/redact.mjs keeps a drift-checked copy.
export const DEFAULT_REDACT: string[] = [
	// Anthropic API and OAuth keys: sk-ant-api03-..., sk-ant-oat01-...
	String.raw`/\bsk-ant-[A-Za-z0-9_-]{20,}/g`,
	// OpenAI keys: sk-..., sk-proj-..., sk-svcacct-..., sk-admin-...
	String.raw`/\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g`,
	// AWS access key id
	String.raw`/\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g`,
	// AWS secret access key when assigned
	String.raw`/(?<=\baws_secret_access_key["']?\s*[:=]\s*["']?)[A-Za-z0-9\/+=]{40}/gi`,
	// GitHub classic tokens: ghp_, gho_, ghu_, ghs_, ghr_
	String.raw`/\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g`,
	// GitHub fine-grained personal access tokens
	String.raw`/\bgithub_pat_[A-Za-z0-9_]{22,255}\b/g`,
	// Bearer tokens (keeps the word "Bearer")
	String.raw`/(?<=\bbearer\s+)[A-Za-z0-9\-._~+\/]{16,}=*/gi`,
	// PEM private key blocks (RSA, EC, OPENSSH, ENCRYPTED, PKCS#8)
	String.raw`/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/g`,
	// Generic assignments: password=..., "api_key": "...", secret: ..., token=... (keeps the key name)
	String.raw`/(?<=\b(?:password|passwd|pwd|secret|client_secret|api[_-]?key|access[_-]?token|auth[_-]?token)["']?\s*[:=]\s*["']?)[^\s"',;&]{4,}/gi`,
	// Password in URLs: scheme://user:PASSWORD@host
	String.raw`/(?<=:\/\/[^\s:@\/]+:)[^\s@\/]+(?=@)/g`,
	// Slack tokens
	String.raw`/\bxox[abprs]-[A-Za-z0-9-]{10,}/g`,
	// Google API keys
	String.raw`/\bAIza[0-9A-Za-z_-]{35}\b/g`,
	// JSON Web Tokens
	String.raw`/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g`,
];

/**
 * A literal every DEFAULT_REDACT match contains (case-insensitive, so broader than each pattern). A string without
 * it cannot match any default pattern, so they are skipped: the look-behind patterns are the bulk of ingest time.
 * The redaction marker holds none of these, so replacing never creates a hint. redact.test checks the hint against
 * every sample and fixture string.
 */
export const DEFAULT_HINT =
	/sk-|AKIA|ASIA|ABIA|ACCA|aws_secret_access_key|gh[pousr]_|github_pat_|bearer|PRIVATE KEY|password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|:\/\/|xox[abprs]-|AIza|eyJ/i;
const DEFAULTS = new Set(DEFAULT_REDACT);

const REDACTED = "[REDACTED]";
const compiled = new Map<string, RegExp | null>();

/** "/body/flags" or a plain body; the result always has the g flag. Invalid → null, never throws. */
export function compilePattern(p: string): RegExp | null {
	let re = compiled.get(p);
	if (re !== undefined) return re;
	const m = /^\/(.*)\/([a-z]*)$/s.exec(p);
	const [body, flags] = m ? [m[1], m[2]] : [p, ""];
	try {
		re = new RegExp(body, flags.includes("g") ? flags : `${flags}g`);
	} catch {
		re = null;
	}
	compiled.set(p, re);
	return re;
}

/** Replaces each "@default" entry with DEFAULT_REDACT, in place. */
export function expandPatterns(list: string[]): string[] {
	return list.flatMap((p) => (p === "@default" ? DEFAULT_REDACT : [p]));
}

type Compiled = { re: RegExp; isDefault: boolean }[];
const compiledLists = new Map<string, Compiled>();

function compileAll(patterns: string[]): Compiled {
	const key = patterns.join("\u0000");
	let list = compiledLists.get(key);
	if (!list) {
		list = expandPatterns(patterns).flatMap((p) => {
			const re = compilePattern(p);
			return re ? [{ re, isDefault: DEFAULTS.has(p) }] : [];
		});
		compiledLists.set(key, list);
	}
	return list;
}

// In list order; the default patterns only when the text holds a hint.
function apply(text: string, list: Compiled): string {
	let out = text;
	let hint: boolean | undefined;
	for (const { re, isDefault } of list) {
		if (isDefault) {
			hint ??= DEFAULT_HINT.test(out);
			if (!hint) continue;
		}
		out = out.replace(re, REDACTED);
	}
	return out;
}

/** Applies the patterns in list order; patterns that do not compile are skipped. */
export function redact(text: string, patterns: string[]): string {
	return apply(text, compileAll(patterns));
}

const markerFor = (removed: number) => `…[truncated ${removed} bytes]`;

// Largest cut ≤ n that does not fall inside a UTF-8 sequence.
function boundary(buf: Buffer, n: number): number {
	let i = Math.min(n, buf.length);
	while (i > 0 && i < buf.length && (buf[i] & 0xc0) === 0x80) i--;
	return i;
}

/** Caps text at maxBytes UTF-8 bytes; the marker counts toward the cap. */
export function capField(text: string, maxBytes: number): string {
	// A UTF-16 code unit is at most 3 UTF-8 bytes: short text needs no byte count.
	if (text.length * 3 <= maxBytes || Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	const buf = Buffer.from(text, "utf8");
	if (buf.length <= maxBytes) return text;
	let budget = maxBytes;
	for (;;) {
		const cut = boundary(buf, budget);
		const marker = markerFor(buf.length - cut);
		const markerBytes = Buffer.byteLength(marker, "utf8");
		if (markerBytes > maxBytes) return buf.subarray(0, boundary(buf, maxBytes)).toString("utf8");
		if (cut + markerBytes <= maxBytes) return buf.subarray(0, cut).toString("utf8") + marker;
		// The marker only grows as the cut shrinks, so this converges.
		budget = maxBytes - markerBytes;
	}
}

function deep(value: unknown, res: Compiled, maxBytes: number): unknown {
	if (typeof value === "string") return capField(apply(value, res), maxBytes);
	if (Array.isArray(value)) return value.map((v) => deep(v, res, maxBytes));
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) out[k] = deep(v, res, maxBytes);
		return out;
	}
	return value;
}

/** Redacts, then caps, every string leaf of a JSON value. Returns a copy; the input is not mutated. */
export function redactDeep<T>(value: T, patterns: string[], maxBytes: number): T {
	return deep(value, compileAll(patterns), maxBytes) as T;
}

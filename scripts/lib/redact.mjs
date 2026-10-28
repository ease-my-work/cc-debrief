// Copied verbatim from docs/features/14-local-only-privacy.md; Phase 1 moves it to src/redact.ts.
export const DEFAULT_REDACT = [
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

// "/body/flags" or a plain body; the result always has the g flag.
export function compilePattern(p) {
	const m = /^\/(.*)\/([a-z]*)$/s.exec(p);
	const [body, flags] = m ? [m[1], m[2]] : [p, ""];
	return new RegExp(body, flags.includes("g") ? flags : `${flags}g`);
}

export const redactString = (s, patterns) => patterns.reduce((acc, re) => acc.replace(re, "[REDACTED]"), s);

// Applies every pattern to every string leaf of a JSON value; returns a new value.
export function redactDeep(value, patterns) {
	if (typeof value === "string") return redactString(value, patterns);
	if (Array.isArray(value)) return value.map((v) => redactDeep(v, patterns));
	if (value && typeof value === "object") {
		const out = {};
		for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v, patterns);
		return out;
	}
	return value;
}

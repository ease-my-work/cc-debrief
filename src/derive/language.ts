// Language of a changed file, from a fixed extension map (feature 04).

const LANGUAGES: Record<string, string> = {
	ts: "ts",
	tsx: "tsx",
	js: "js",
	jsx: "jsx",
	mjs: "js",
	cjs: "js",
	py: "py",
	go: "go",
	rs: "rs",
	java: "java",
	kt: "kt",
	rb: "rb",
	php: "php",
	cs: "cs",
	cpp: "cpp",
	c: "c",
	h: "h",
	swift: "swift",
	sql: "sql",
	sh: "sh",
	ps1: "ps1",
	md: "md",
	json: "json",
	yaml: "yaml",
	yml: "yaml",
	toml: "toml",
	html: "html",
	css: "css",
	scss: "scss",
};

export function languageFor(path: string): string | null {
	const base = path.split(/[\\/]/).pop() ?? "";
	const dot = base.lastIndexOf(".");
	if (dot <= 0) return null; // no extension, or a dotfile such as .bashrc
	return LANGUAGES[base.slice(dot + 1).toLowerCase()] ?? null;
}

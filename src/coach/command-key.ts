// Shell command key (feature 07 shared definitions): groups Bash and PowerShell calls for retry loops, MCP bypass
// and failure hotspots. Only the first segment of a compound command is keyed, so `cd a && make build` is `cd`
// (the shell's first step is what failed or succeeded first; later steps are not parsed).

// Tools whose first subcommand is part of the key ("npm test", "git status").
const WITH_SUBCOMMAND = new Set(["npm", "pnpm", "yarn", "git", "docker", "cargo", "go", "make", "uv", "poetry"]);
const PYTHON = /^(python|python3(\.\d+)?|py)$/;

/** Splits a segment into words, honouring single and double quotes (quotes removed). */
function words(segment: string): string[] {
	const out: string[] = [];
	const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
	for (let m = re.exec(segment); m; m = re.exec(segment)) out.push(m[1] ?? m[2] ?? m[3]);
	return out;
}

/** Basename without directories (either slash) or a trailing `.exe`, lowercased. */
function executable(word: string): string {
	const base = word.split(/[\\/]/).pop() ?? word;
	return base.replace(/\.exe$/i, "").toLowerCase();
}

/** The next word that is not a flag, or undefined. */
const firstArg = (rest: string[]): number => rest.findIndex((w) => !w.startsWith("-"));

function keyOf(ws: string[]): string {
	// Leading VAR=x assignments, sudo and the PowerShell call operator.
	let i = 0;
	while (i < ws.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(ws[i]) || ws[i] === "sudo" || ws[i] === "&")) i++;
	if (i >= ws.length) return "";
	const exe = executable(ws[i]);
	const rest = ws.slice(i + 1);
	if (exe === "npx") {
		const j = firstArg(rest);
		return j === -1 ? exe : keyOf(rest.slice(j));
	}
	if (PYTHON.test(exe) && rest[0] === "-m" && rest[1]) return keyOf(rest.slice(1));
	if (exe === "uv" && rest[0] === "run" && rest[1]) return keyOf(rest.slice(1));
	if (WITH_SUBCOMMAND.has(exe) && rest[0] !== undefined && !rest[0].startsWith("-")) return `${exe} ${rest[0]}`;
	return exe;
}

/** Feature 07 command key: `npm test -- -u` → `npm test`, `python -m pytest` → `pytest`; '' for an empty command. */
export function commandKey(command: string): string {
	const first = command.split(/&&|\|\||[;|\n]/)[0] ?? "";
	return keyOf(words(first.trim()));
}

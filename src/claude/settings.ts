// Claude Code's settings.json: the only file under CLAUDE_CONFIG_DIR the tracker ever writes, and only from
// init / uninit. Edits are made in place with jsonc-parser, so everything outside our own entries keeps its bytes
// (formatting, number spelling, escapes, key order); the file is validated as strict JSON before and after.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { findNodeAtLocation, type Node as JsonNode, parseTree } from "jsonc-parser";
import { ensureDir } from "../paths";

export const HOOK_MARKER = "# cc-debrief";
export const SUBSCRIBED_EVENTS = ["SessionStart", "Stop", "PermissionRequest", "SessionEnd"] as const;
export type HookEvent = (typeof SUBSCRIBED_EVENTS)[number];

// Stop runs async (never delays a turn); SessionEnd raises Claude Code's shared 1.5 s budget (Phase 0 B6/B7).
export const HOOK_ENTRY_OPTIONS: Record<HookEvent, { async?: true; timeout?: number }> = {
	SessionStart: {},
	Stop: { async: true },
	PermissionRequest: {},
	SessionEnd: { timeout: 3600 },
};

/** settings.json is not valid JSON (or not the expected shape); the CLI exits 3 and writes nothing. */
export class SettingsError extends Error {
	override name = "SettingsError";
}

export const hookCommand = (hookJsAbsPath: string): string => `node "${hookJsAbsPath}" ${HOOK_MARKER}`;

export const sha256 = (bytes: Buffer | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

export function readSettingsBytes(path: string): Buffer | null {
	try {
		return readFileSync(path);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw e;
	}
}

type Obj = Record<string, unknown>;
type Hook = { command?: unknown } & Obj;
type Group = { hooks?: unknown } & Obj;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isOurs = (h: unknown) => isObj(h) && typeof h.command === "string" && h.command.includes(HOOK_MARKER);

function parseStrict(path: string, text: string): Obj {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new SettingsError(`${path} is not valid JSON; fix it (or edit the hooks by hand) and run again`);
	}
	if (!isObj(value)) throw new SettingsError(`${path} does not hold a JSON object`);
	if (value.hooks !== undefined) {
		if (!isObj(value.hooks)) throw new SettingsError(`${path}: "hooks" is not an object`);
		for (const [event, groups] of Object.entries(value.hooks)) {
			if (!Array.isArray(groups)) throw new SettingsError(`${path}: hooks.${event} is not an array`);
		}
	}
	return value;
}

// The document being edited, with the file's indent unit and line ending for the text we add. `pretty` decides
// the style of text added into an empty container (multi-line unless the file is a single line).
type Doc = { text: string; unit: string; eol: string; pretty: boolean };

function docOf(text: string, isNew: boolean): Doc {
	const eol = text.includes("\r\n") ? "\r\n" : "\n";
	const indented = text.split(/\r?\n/).find((l) => /^[ \t]+\S/.test(l));
	const unit = indented?.startsWith("\t") ? "\t" : " ".repeat(indented?.match(/^ +/)?.[0].length ?? 2);
	return { text, unit, eol, pretty: isNew || text.includes("\n") };
}

// All edits work on text offsets from jsonc-parser's parse tree and never reformat existing text. (jsonc-parser's
// own modify() reformats whole lines around an insertion, and in 3.3.1 drops the closing bracket when it removes
// the last element of an array.)
const nodeAt = (doc: Doc, path: (string | number)[]) => findNodeAtLocation(parseTree(doc.text) as JsonNode, path);

function lineIndent(text: string, offset: number): string {
	const start = text.lastIndexOf("\n", offset - 1) + 1;
	return /^[ \t]*/.exec(text.slice(start, offset))?.[0] ?? "";
}

const render = (doc: Doc, value: unknown, indent: string, multiline: boolean) =>
	multiline
		? JSON.stringify(value, null, doc.unit)
				.split("\n")
				.join(doc.eol + indent)
		: JSON.stringify(value);

// Adds an item after the container's last child, in the container's own style (one line or one item per line).
function insertItem(doc: Doc, container: JsonNode, item: (indent: string, multiline: boolean) => string): void {
	const kids = container.children ?? [];
	let at: number;
	let text: string;
	if (kids.length > 0) {
		const last = kids[kids.length - 1];
		const multiline = doc.text.slice(container.offset, kids[0].offset).includes("\n");
		const indent = multiline ? lineIndent(doc.text, last.offset) : "";
		at = last.offset + last.length;
		text = (multiline ? `,${doc.eol}${indent}` : ", ") + item(indent, multiline);
		doc.text = doc.text.slice(0, at) + text + doc.text.slice(at);
		return;
	}
	const outer = lineIndent(doc.text, container.offset);
	const indent = outer + doc.unit;
	text = doc.pretty ? `${doc.eol}${indent}${item(indent, true)}${doc.eol}${outer}` : item("", false);
	doc.text = doc.text.slice(0, container.offset + 1) + text + doc.text.slice(container.offset + container.length - 1);
}

function appendElement(doc: Doc, arrayPath: (string | number)[], value: unknown): void {
	insertItem(doc, nodeAt(doc, arrayPath) as JsonNode, (indent, ml) => render(doc, value, indent, ml));
}

function addProperty(doc: Doc, objectPath: (string | number)[], key: string, value: unknown): void {
	const container = nodeAt(doc, objectPath) as JsonNode;
	insertItem(doc, container, (indent, ml) => `${JSON.stringify(key)}: ${render(doc, value, indent, ml)}`);
}

function replaceAt(doc: Doc, path: (string | number)[], value: unknown): void {
	const node = nodeAt(doc, path) as JsonNode;
	const old = doc.text.slice(node.offset, node.offset + node.length);
	const text = render(doc, value, lineIndent(doc.text, node.offset), old.includes("\n"));
	doc.text = doc.text.slice(0, node.offset) + text + doc.text.slice(node.offset + node.length);
}

// Deletes an array element or object property together with its separating comma and whitespace.
function remove(doc: Doc, path: (string | number)[]): void {
	const target = nodeAt(doc, path);
	if (!target) return;
	const item = target.parent?.type === "property" ? target.parent : target; // a property, or an array element
	const container = item.parent as JsonNode;
	const siblings = container.children ?? [];
	const i = siblings.indexOf(item);
	let from: number;
	let to: number;
	if (siblings.length === 1) {
		from = container.offset + 1; // empty the container: [] / {}
		to = container.offset + container.length - 1;
	} else if (i < siblings.length - 1) {
		from = item.offset; // up to the next sibling: the item, its comma and the whitespace after
		to = siblings[i + 1].offset;
	} else {
		from = siblings[i - 1].offset + siblings[i - 1].length; // from the previous sibling's end: comma and item
		to = item.offset + item.length;
	}
	doc.text = doc.text.slice(0, from) + doc.text.slice(to);
}
const hooksOf = (doc: Doc): Obj | undefined => {
	const h = (JSON.parse(doc.text) as Obj).hooks;
	return isObj(h) ? h : undefined;
};

// Every tracker hook as [event, group index, hook index], in file order.
function trackerHooks(hooks: Obj | undefined): [string, number, number][] {
	const out: [string, number, number][] = [];
	for (const [event, groups] of Object.entries(hooks ?? {})) {
		(groups as Group[]).forEach((g, gi) => {
			if (!isObj(g) || !Array.isArray(g.hooks)) return;
			g.hooks.forEach((h, hi) => {
				if (isOurs(h)) out.push([event, gi, hi]);
			});
		});
	}
	return out;
}

// Removes one hook; a group it leaves empty goes too, and so does an event array when dropEmptyEvent says so.
function removeHookAt(doc: Doc, event: string, gi: number, hi: number, dropEmptyEvent: boolean): void {
	const groups = hooksOf(doc)?.[event] as Group[];
	const group = groups[gi];
	if (Array.isArray(group.hooks) && group.hooks.length > 1) {
		remove(doc, ["hooks", event, gi, "hooks", hi]);
		return;
	}
	if (groups.length === 1 && dropEmptyEvent) remove(doc, ["hooks", event]);
	else remove(doc, ["hooks", event, gi]);
}

function sameHook(a: Obj, b: Obj): boolean {
	const ka = Object.keys(a);
	return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
}

function stamp(d = new Date()): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function backupPathFor(path: string): string {
	const base = `${path}.cc-debrief-${stamp()}`;
	let candidate = `${base}.bak`;
	for (let i = 1; existsSync(candidate); i++) candidate = `${base}-${i}.bak`;
	return candidate;
}

/**
 * Atomic replace: a temp file beside the real file, then rename onto it. A symlinked settings.json (a dotfiles
 * repo) is written through the link: the link stays and its target gets the new bytes (feature 13 edge cases).
 */
export function replaceFile(path: string, bytes: string | Buffer): void {
	const real = existsSync(path) ? realpathSync(path) : path;
	const tmp = `${real}.cc-debrief-tmp-${process.pid}`;
	writeFileSync(tmp, bytes);
	renameSync(tmp, real);
}

// Atomic replace, then re-read and parse, putting the original back if that fails.
function writeVerified(path: string, out: string, original: Buffer | null): void {
	replaceFile(path, out);
	try {
		parseStrict(path, readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
	} catch (e) {
		if (original) writeFileSync(path, original);
		else rmSync(path, { force: true });
		throw new Error(
			`${path} did not read back as valid JSON after writing; the original was restored (${(e as Error).message})`,
		);
	}
}

export type InstallResult = {
	added: string[];
	skipped: string[];
	replaced: string[];
	staleRemoved: string[];
	backupPath: string | null; // null when the file did not exist or nothing changed
	/** "<file>", "hooks" and "hooks.<event>" for what did not exist before (meta init.created, used by uninit). */
	created: string[];
	changed: boolean;
	beforeSha: string | null;
	afterSha: string;
};

/**
 * Merges the tracker's hook entries into settings.json (feature 13 init step 3). Per event: an identical entry is
 * skipped, a tracker entry with another command or other options is replaced in place, else a group is appended.
 * Tracker entries under events it does not subscribe to are removed. Other entries are never touched.
 */
export function installHooks(
	settingsPath: string,
	command: string,
	opts: { permissionHook?: boolean } = {},
): InstallResult {
	const original = readSettingsBytes(settingsPath);
	let text = original ? original.toString("utf8") : "{}";
	const bom = text.startsWith("\uFEFF");
	if (bom) text = text.slice(1);
	const before = parseStrict(settingsPath, text);
	const doc = docOf(text, !original);
	const active: string[] = SUBSCRIBED_EVENTS.filter((e) => e !== "PermissionRequest" || opts.permissionHook !== false);
	const result: InstallResult = {
		added: [],
		skipped: [],
		replaced: [],
		staleRemoved: [],
		backupPath: null,
		created: [],
		changed: false,
		beforeSha: original ? sha256(original) : null,
		afterSha: original ? sha256(original) : "",
	};
	if (!original) result.created.push("<file>");
	if (!isObj(before.hooks)) result.created.push("hooks");

	// Tracker entries under events no longer subscribed (older versions, or PermissionRequest turned off).
	for (;;) {
		const stale = trackerHooks(hooksOf(doc)).find(([event]) => !active.includes(event));
		if (!stale) break;
		removeHookAt(doc, stale[0], stale[1], stale[2], true);
		if (!result.staleRemoved.includes(stale[0])) result.staleRemoved.push(stale[0]);
	}

	for (const event of active) {
		const desired = { type: "command", command, ...HOOK_ENTRY_OPTIONS[event as HookEvent] };
		const hooks = hooksOf(doc);
		const found = trackerHooks(hooks).filter(([e]) => e === event);
		if (found.length === 0) {
			const group = { hooks: [desired] };
			if (!hooks) addProperty(doc, [], "hooks", { [event]: [group] });
			else if (!Array.isArray(hooks[event])) addProperty(doc, ["hooks"], event, [group]);
			else appendElement(doc, ["hooks", event], group);
			if (!hooks || !Array.isArray(hooks[event])) result.created.push(`hooks.${event}`);
			result.added.push(event);
			continue;
		}
		const [, gi, hi] = found[0];
		const existing = (((hooks as Obj)[event] as Group[])[gi].hooks as Hook[])[hi];
		const identical = sameHook(existing, desired);
		// Duplicates from an earlier bug or a hand edit: keep the first, drop the rest (last first, so indexes hold).
		for (const [, dgi, dhi] of found.slice(1).reverse()) removeHookAt(doc, event, dgi, dhi, false);
		if (!identical) replaceAt(doc, ["hooks", event, gi, "hooks", hi], desired);
		(identical && found.length === 1 ? result.skipped : result.replaced).push(event);
	}

	result.changed = !original || doc.text !== text;
	if (!result.changed) {
		result.created = [];
		return result;
	}
	const out = (bom ? "\uFEFF" : "") + doc.text + (original ? "" : doc.eol);
	if (original) {
		result.backupPath = backupPathFor(settingsPath);
		copyFileSync(settingsPath, result.backupPath);
	} else {
		ensureDir(dirname(settingsPath));
	}
	writeVerified(settingsPath, out, original);
	result.afterSha = sha256(Buffer.from(out, "utf8"));
	return result;
}

/**
 * Removes every hook whose command carries the marker (feature 13 uninit step 3). A group goes only when the
 * removal empties it; an event array or the hooks key only when empty and listed in `created` (from init), or,
 * without that list, when the removal emptied it.
 */
export function removeHooks(settingsPath: string, opts: { created?: string[] } = {}): { removed: string[] } {
	const original = readSettingsBytes(settingsPath);
	if (!original) return { removed: [] };
	let text = original.toString("utf8");
	const bom = text.startsWith("\uFEFF");
	if (bom) text = text.slice(1);
	parseStrict(settingsPath, text);
	const doc = docOf(text, false);
	const removed = new Set<string>();
	const hadHooks = Object.keys(hooksOf(doc) ?? {}).length > 0;

	for (;;) {
		const next = trackerHooks(hooksOf(doc))[0];
		if (!next) break;
		const [event, gi, hi] = next;
		removeHookAt(doc, event, gi, hi, opts.created ? opts.created.includes(`hooks.${event}`) : true);
		removed.add(event);
	}
	const hooks = hooksOf(doc);
	const dropHooks = opts.created ? opts.created.includes("hooks") : hadHooks && removed.size > 0;
	if (hooks && Object.keys(hooks).length === 0 && dropHooks) remove(doc, ["hooks"]);

	if (removed.size > 0) writeVerified(settingsPath, (bom ? "\uFEFF" : "") + doc.text, original);
	const order = (e: string) => {
		const i = (SUBSCRIBED_EVENTS as readonly string[]).indexOf(e);
		return i === -1 ? SUBSCRIBED_EVENTS.length : i;
	};
	return { removed: [...removed].sort((a, b) => order(a) - order(b)) };
}

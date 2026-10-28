import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const tmpDir = () => mkdtempSync(join(tmpdir(), "ccd-"));

export function writeJsonl(file, objects) {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${objects.map((o) => JSON.stringify(o)).join("\n")}\n`);
}

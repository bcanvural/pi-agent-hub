// The hub's one durable write: its own settings file, atomic tmp+rename.
// Read defensively — a file on disk is a file anyone can corrupt, ours
// included.
import * as fs from "node:fs";
import * as path from "node:path";

export const DEFAULT_SIZE = 80;

export function clampSize(size: number): number {
	return Math.min(100, Math.max(40, Math.round(size)));
}

export function readSavedSize(file: string): number {
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { size?: unknown };
		if (typeof parsed.size === "number" && Number.isFinite(parsed.size)) return clampSize(parsed.size);
	} catch {
		// Missing or corrupt: the default below.
	}
	return DEFAULT_SIZE;
}

export function saveSize(file: string, size: number): void {
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const tmp = `${file}.tmp-${process.pid}`;
		fs.writeFileSync(tmp, `${JSON.stringify({ size: clampSize(size) })}\n`);
		fs.renameSync(tmp, file);
	} catch {
		// A size that does not stick is an inconvenience, never a crash.
	}
}

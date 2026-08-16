// The mid-tool liveness gap, narrowed: while a child sits inside one long tool
// call, its session file holds only the call — the result arrives when the
// tool ends. The run's output log, though, streams as the tool runs, so a
// bounded, sanitized tail of it is shown under the transcript while a run is
// live. Raw tool stdout is untrusted for a terminal: escape sequences and
// control bytes would break pi's row accounting, so everything but plain text
// is stripped before a line is kept.
import * as fs from "node:fs";

const READ_BYTES = 16 * 1024;

export interface OutputTail {
	/** size:mtime of the file this tail was read from — reread only on change. */
	stamp: string;
	lines: string[];
}

const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const CSI = /\x1b\[[0-9;:?]*[ -/]*[@-~]/g;
const OTHER_ESCAPE = /\x1b./g;
// U+2028/U+2029 are line separators outside the C0/C1 ranges: not terminal
// control bytes, but a line break all the same, and a "line" carrying one
// becomes two rows in whatever renders it next. Newly reachable when a
// supervisor request's message — genuinely multi-line upstream — began
// being rendered.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/** One line of untrusted text made safe for a terminal row: escapes and
 * control bytes stripped, tabs spaced. Exported because every foreign string
 * the hub interpolates into a row — agent names, models, bridge reply text —
 * needs exactly this treatment, not only tool stdout. */
export function sanitizeLine(line: string): string {
	return line.replace(OSC, "").replace(CSI, "").replace(OTHER_ESCAPE, "").replace(/\t/g, "  ").replace(CONTROL, "");
}

/** Read the last lines of `filePath`, reusing `previous` when it is unchanged.
 * Returns undefined when there is no file or nothing printable in it. */
export function readOutputTail(filePath: string, maxLines: number, previous?: OutputTail): OutputTail | undefined {
	let stat: fs.Stats;
	try {
		stat = fs.statSync(filePath);
	} catch {
		return undefined;
	}
	if (stat.size === 0) return undefined;
	const stamp = `${stat.size}:${Math.trunc(stat.mtimeMs)}`;
	if (previous && previous.stamp === stamp) return previous;

	const offset = Math.max(0, stat.size - READ_BYTES);
	let text: string;
	try {
		const fd = fs.openSync(filePath, "r");
		try {
			const buffer = Buffer.alloc(Math.min(READ_BYTES, stat.size));
			const read = fs.readSync(fd, buffer, 0, buffer.length, offset);
			text = buffer.subarray(0, Math.max(0, read)).toString("utf8");
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return undefined;
	}

	const raw = text.split(/\r\n|\r|\n/);
	// A mid-file start lands mid-line; and a writer mid-append leaves a partial
	// final line. Drop both rather than show half of either. The partial-line
	// verdict is taken before the head is dropped — deciding it afterwards let
	// a window holding exactly one newline show its half-written tail.
	const endsMidLine = !text.endsWith("\n");
	if (offset > 0) raw.shift();
	if (endsMidLine && raw.length > 0) raw.pop();
	const lines = raw.map(sanitizeLine).filter(line => line.trim().length > 0).slice(-maxLines);
	if (lines.length === 0) return undefined;
	return { stamp, lines };
}

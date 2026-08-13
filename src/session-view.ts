// The chat pane's substance: tail a child's session file and render its
// messages through pi's own interactive components, so a child transcript
// looks exactly like the main window — same markdown, same tool renderers,
// same diffs, and the same treatment from any extension that restyles those
// component prototypes.
import * as fs from "node:fs";
import {
	AssistantMessageComponent,
	ToolExecutionComponent,
	UserMessageComponent,
	getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type TUI } from "@earendil-works/pi-tui";

/** Only this much of a large session is read, from the end. Sessions here run
 * to megabytes; the pane is a viewer, not an archaeologist. */
const MAX_TAIL_BYTES = 4 * 1024 * 1024;

/** Newest records rendered. Rendering is rebuilt whole on change, so the
 * bound is what keeps a long-lived child affordable. */
const MAX_RECORDS = 400;

interface SessionRecord {
	type?: string;
	message?: {
		role?: string;
		content?: unknown;
		toolCallId?: string;
		toolName?: string;
		isError?: boolean;
		details?: unknown;
	} & Record<string, unknown>;
}

/** Incremental reader for a session JSONL file someone else is writing.
 *
 * Appends are consumed from a byte offset; a shrinking file (rewritten or
 * replaced) resets the tail. The leftover partial line is kept as BYTES, not
 * string — a UTF-8 sequence split across two polls must not be decoded in
 * halves. */
export class SessionTail {
	readonly records: SessionRecord[] = [];
	readonly filePath: string;
	truncatedHead = false;
	/** False once the file has gone missing — the pane says so rather than
	 * showing an empty conversation and letting the reader assume silence. */
	fileExists = true;
	private offset = 0;
	private leftover: Buffer = Buffer.alloc(0);
	private skipFirstLine = false;
	private started = false;
	/** Which file the offset belongs to. A session that is rewritten in place
	 * (pi migrates a resumed session by reopening it "w") keeps its path and
	 * can come back LARGER, so size alone cannot detect the swap — and reading
	 * on from a stale offset would splice the new file's tail onto the old
	 * file's head and present the result as one conversation. */
	private identity = "";

	constructor(filePath: string) {
		this.filePath = filePath;
	}

	/** Consume anything new. True when records were appended or reset. */
	poll(): boolean {
		let stat: fs.Stats;
		try {
			stat = fs.statSync(this.filePath);
		} catch {
			const had = this.fileExists;
			this.fileExists = false;
			return had;
		}
		this.fileExists = true;
		const identity = `${stat.ino}:${stat.dev}:${Math.trunc(stat.birthtimeMs)}`;
		if (this.started && identity !== this.identity) {
			// A different file wearing the same name: start over rather than
			// stitch two transcripts together.
			this.started = false;
		}
		this.identity = identity;
		if (!this.started || stat.size < this.offset) {
			this.records.length = 0;
			this.leftover = Buffer.alloc(0);
			this.truncatedHead = stat.size > MAX_TAIL_BYTES;
			this.offset = this.truncatedHead ? stat.size - MAX_TAIL_BYTES : 0;
			// A mid-file start lands mid-line; the first newline is the seam.
			this.skipFirstLine = this.truncatedHead;
			this.started = true;
		}
		if (stat.size === this.offset) return false;

		let fd: number;
		try {
			fd = fs.openSync(this.filePath, "r");
		} catch {
			return false;
		}
		let chunk: Buffer;
		try {
			const buffer = Buffer.alloc(stat.size - this.offset);
			// Only what was actually read: a writer truncating between the stat
			// and the read returns short, and trusting the requested length
			// would advance past bytes that never arrived and feed the
			// allocation's zero fill into the parser as if it were content.
			const read = fs.readSync(fd, buffer, 0, buffer.length, this.offset);
			chunk = read === buffer.length ? buffer : buffer.subarray(0, Math.max(0, read));
			this.offset += chunk.length;
		} catch {
			return false;
		} finally {
			fs.closeSync(fd);
		}
		if (chunk.length === 0) return false;

		const data = this.leftover.length > 0 ? Buffer.concat([this.leftover, chunk]) : chunk;
		const lastNewline = data.lastIndexOf(0x0a);
		if (lastNewline === -1) {
			this.leftover = data;
			return false;
		}
		this.leftover = data.subarray(lastNewline + 1);

		let appended = false;
		for (let line of data.subarray(0, lastNewline).toString("utf8").split("\n")) {
			if (this.skipFirstLine) {
				this.skipFirstLine = false;
				continue;
			}
			line = line.trim();
			if (!line) continue;
			try {
				const record = JSON.parse(line) as SessionRecord;
				// Sessions interleave message records with bookkeeping
				// (model_change, session_info, …); the pane shows conversation.
				if (record.type === "message" && record.message) {
					this.records.push(record);
					appended = true;
				}
			} catch {
				// A malformed line is someone else's bug mid-write; skip it.
			}
		}
		if (this.records.length > MAX_RECORDS) {
			this.records.splice(0, this.records.length - MAX_RECORDS);
			this.truncatedHead = true;
		}
		return appended;
	}
}

export interface ChatRenderOptions {
	tui: TUI;
	cwd: string;
	expandedTools: boolean;
	/** Dim styler for the pane's own furniture (markers, notices). */
	dim: (text: string) => string;
	/** How many lines the pane will actually show. */
	viewHeight: number;
	/** Lines up from the newest; 0 is the live tail. */
	scroll: number;
}

export interface ChatWindow {
	/** Exactly the slice to display, at most `viewHeight` lines. */
	lines: string[];
	/** Lines produced while filling the window — a floor on the true total,
	 * since older records are only rendered if the window reaches them. */
	linesKnown: number;
	/** The walk consumed every retained record: `linesKnown` is the total. */
	atOldest: boolean;
}

/** Lines one tool call may contribute before the pane summarises it.
 *
 * Pi's own renderers already bound their built-ins, but a tool with no
 * registered renderer falls through to a generic path that ignores
 * `setExpanded` and prints its whole result — around 40% of the calls in real
 * sessions here, and unbounded in size. The cap is what makes expand/collapse
 * mean something for those, and what stops one 200k-line result from being
 * built at all. */
const TOOL_LINES_COLLAPSED = 14;
const TOOL_LINES_EXPANDED = 600;
/** Kept from the top of a capped group, so the call itself stays visible. */
const TOOL_HEAD_LINES = 3;

function textOfBlocks(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map(block => (typeof block === "object" && block !== null && (block as { type?: string }).type === "text" ? String((block as { text?: unknown }).text ?? "") : ""))
		.filter(Boolean)
		.join("\n");
}

interface GroupCacheEntry {
	width: number;
	expandedTools: boolean;
	lines: string[];
}

/** Rendered lines per record, keyed on the record object itself, so scrolling
 * and polling reuse work instead of repeating it. Weak, so trimming the tail's
 * records releases their lines too. */
const groupCache = new WeakMap<object, GroupCacheEntry>();

function capToolLines(lines: string[], expanded: boolean, dim: (text: string) => string): string[] {
	const budget = expanded ? TOOL_LINES_EXPANDED : TOOL_LINES_COLLAPSED;
	if (lines.length <= budget) return lines;
	const tailKeep = Math.max(1, budget - TOOL_HEAD_LINES - 1);
	const hidden = lines.length - TOOL_HEAD_LINES - tailKeep;
	return [
		...lines.slice(0, TOOL_HEAD_LINES),
		dim(`  … ${hidden} lines hidden${expanded ? "" : " · x to expand"}`),
		...lines.slice(-tailKeep),
	];
}

function renderRecord(
	record: SessionRecord,
	resultsByCallId: Map<string, NonNullable<SessionRecord["message"]>>,
	width: number,
	options: ChatRenderOptions,
): string[] {
	const message = record.message;
	if (!message) return [];
	const markdownTheme = getMarkdownTheme();
	const lines: string[] = [];

	if (message.role === "user") {
		const text = textOfBlocks(message.content);
		if (text.trim()) lines.push(...new UserMessageComponent(text, markdownTheme).render(width));
		return lines;
	}
	if (message.role !== "assistant") return lines;

	// Guard before constructing, not after: the component reads `content`
	// eagerly and throws on a shape it does not expect.
	if (!Array.isArray(message.content)) return lines;
	lines.push(...new AssistantMessageComponent(message as never, false, markdownTheme).render(width));

	for (const block of message.content) {
		if (typeof block !== "object" || block === null) continue;
		const call = block as { type?: string; id?: string; name?: string; arguments?: unknown };
		if (call.type !== "toolCall" || typeof call.name !== "string") continue;
		const callId = typeof call.id === "string" ? call.id : `hub-${lines.length}`;
		const component = new ToolExecutionComponent(
			call.name,
			callId,
			call.arguments ?? {},
			undefined,
			undefined,
			options.tui,
			options.cwd,
		);
		component.setArgsComplete();
		// Deliberately no markExecutionStarted(): the component would time its
		// own instant replay and print a fabricated duration.
		const result = resultsByCallId.get(callId);
		// The component filters `content` without checking it is a list.
		if (result && Array.isArray(result.content)) component.updateResult(result as never);
		component.setExpanded(options.expandedTools);
		lines.push(...capToolLines(component.render(width), options.expandedTools, options.dim));
	}
	return lines;
}

/** Render just the window the pane will show.
 *
 * Records are walked newest-first and stop as soon as the window is full, so
 * the cost is the size of the viewport rather than the size of the session.
 * Rendering the whole retained transcript instead made a cold rebuild take
 * over a second on a real 7 MB session — paid on the host's event loop, which
 * is the same one serving the user's own conversation.
 *
 * Every record is rendered behind a catch. These are foreign components
 * reading a file another process writes; an exception here reaches pi's
 * uncaught handler, which exits the user's session outright. */
export function buildChatWindow(tail: SessionTail, width: number, options: ChatRenderOptions): ChatWindow {
	const resultsByCallId = new Map<string, NonNullable<SessionRecord["message"]>>();
	for (const record of tail.records) {
		const message = record.message;
		if (message?.role === "toolResult" && typeof message.toolCallId === "string") {
			// First result wins, matching how the session was actually consumed.
			if (!resultsByCallId.has(message.toolCallId)) resultsByCallId.set(message.toolCallId, message);
		}
	}

	const wanted = Math.max(1, options.viewHeight + Math.max(0, options.scroll));
	const groups: string[][] = [];
	let linesKnown = 0;
	let index = tail.records.length - 1;
	for (; index >= 0 && linesKnown < wanted; index--) {
		const record = tail.records[index]!;
		const cached = groupCache.get(record);
		let lines: string[];
		if (cached && cached.width === width && cached.expandedTools === options.expandedTools) {
			lines = cached.lines;
		} else {
			try {
				lines = renderRecord(record, resultsByCallId, width, options);
			} catch (error) {
				lines = [options.dim(`⚠ unreadable record: ${error instanceof Error ? error.message : String(error)}`)];
			}
			groupCache.set(record, { width, expandedTools: options.expandedTools, lines });
		}
		groups.push(lines);
		linesKnown += lines.length;
	}
	const atOldest = index < 0;

	const all: string[] = [];
	for (let group = groups.length - 1; group >= 0; group--) all.push(...groups[group]!);
	if (atOldest) {
		while (all.length > 0 && !(all.at(-1) ?? "").trim()) all.pop();
		if (tail.truncatedHead) all.unshift(options.dim("↑ earlier conversation omitted"));
	}

	const scroll = Math.min(Math.max(0, options.scroll), Math.max(0, all.length - options.viewHeight));
	const end = all.length - scroll;
	const window = all.slice(Math.max(0, end - options.viewHeight), end);
	// Pi's renderer throws on any row wider than the terminal, and these rows
	// come from components that were not told our width is a panel column.
	return { lines: window.map(line => truncateToWidth(line, width)), linesKnown: all.length, atOldest };
}

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
	truncatedHead = false;
	private offset = 0;
	private leftover: Buffer = Buffer.alloc(0);
	private skipFirstLine = false;
	private started = false;

	constructor(readonly filePath: string) {}

	/** Consume anything new. True when records were appended or reset. */
	poll(): boolean {
		let stat: fs.Stats;
		try {
			stat = fs.statSync(this.filePath);
		} catch {
			return false;
		}
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
			chunk = Buffer.alloc(stat.size - this.offset);
			fs.readSync(fd, chunk, 0, chunk.length, this.offset);
		} finally {
			fs.closeSync(fd);
		}
		this.offset = stat.size;

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
	/** Dim styler for the pane's own furniture (omitted-head marker). */
	dim: (text: string) => string;
}

function textOfBlocks(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map(block => (typeof block === "object" && block !== null && (block as { type?: string }).type === "text" ? String((block as { text?: unknown }).text ?? "") : ""))
		.filter(Boolean)
		.join("\n");
}

/** Render the tail's records at `width`. Rebuilt whole on every change the
 * memo in the hub component doesn't absorb; MAX_RECORDS is what makes that
 * affordable. */
export function buildChatLines(tail: SessionTail, width: number, options: ChatRenderOptions): string[] {
	const markdownTheme = getMarkdownTheme();
	const lines: string[] = [];
	if (tail.truncatedHead) lines.push(options.dim("↑ earlier conversation omitted"));

	const resultsByCallId = new Map<string, NonNullable<SessionRecord["message"]>>();
	for (const record of tail.records) {
		const message = record.message;
		if (message?.role === "toolResult" && typeof message.toolCallId === "string") {
			// First result wins, matching how the session was actually consumed.
			if (!resultsByCallId.has(message.toolCallId)) resultsByCallId.set(message.toolCallId, message);
		}
	}

	for (const record of tail.records) {
		const message = record.message;
		if (!message) continue;
		if (message.role === "user") {
			const text = textOfBlocks(message.content);
			if (text.trim()) lines.push(...new UserMessageComponent(text, markdownTheme).render(width));
			continue;
		}
		if (message.role !== "assistant") continue;
		lines.push(...new AssistantMessageComponent(message as never, false, markdownTheme).render(width));
		if (!Array.isArray(message.content)) continue;
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
			// Deliberately no markExecutionStarted(): the component would time
			// its own instant replay and print a fabricated duration.
			const result = resultsByCallId.get(callId);
			if (result) component.updateResult(result as never);
			component.setExpanded(options.expandedTools);
			lines.push(...component.render(width));
		}
	}

	while (lines.length > 0 && !(lines.at(-1) ?? "").trim()) lines.pop();
	// pi's renderer throws on any row wider than the terminal; a foreign
	// component's row is never trusted to fit.
	return lines.map(line => truncateToWidth(line, width));
}

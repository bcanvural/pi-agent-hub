// The hub overlay: a roster of background agents on the left, the selected
// child's conversation on the right, live — and a composer to talk back.
// Watching is free; every control goes through the owning extension's RPC,
// with that extension's own file inbox as the only fallback, and the label on
// each send says what actually happened to it (delivered, queued, parked).
import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { findAck, readCapability, runnerReachable, steerInboxClosed, writeControlRequest, writeSteerRequestFile } from "./control-files.ts";
import { readOutputTail, type OutputTail } from "./output-tail.ts";
import { asyncRunsRoot, isStale, MAX_ROWS, rowKey, scanRuns, type RunRow, type ScanCache } from "./runs.ts";
import { SubagentsRpc, type FleetSnapshot, type RpcEvents } from "./rpc.ts";
import { bottomOffsetOfRecord, buildChatWindow, recordPlainText, SessionTail, type ChatGroupSpan } from "./session-view.ts";

const LIST_REFRESH_MS = 2000;
const TAIL_POLL_MS = 500;
const ACK_WAIT_MS = 25_000;
const LIVE_OUTPUT_LINES = 6;
const COMPOSER_MAX_CHARS = 8000;

type Mode = "nav" | "compose" | "search" | "confirmStop";

interface ChatMemo {
	recordCount: number;
	truncatedHead: boolean;
	width: number;
	height: number;
	expandedTools: boolean;
	overrideGen: number;
	scroll: number;
	liveStamp: string;
	lines: string[];
	linesKnown: number;
	atOldest: boolean;
	groups: ChatGroupSpan[];
}

interface Notice {
	text: string;
	tone: "info" | "success" | "error";
	at: number;
}

interface AckWatch {
	runDir: string;
	index: number;
	requestId: string;
	sentAt: number;
}

function formatAge(from: number | undefined, now: number): string {
	if (!from) return "";
	const seconds = Math.max(0, Math.round((now - from) / 1000));
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
	if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
	return `${Math.round(seconds / 86400)}d`;
}

/** Keystrokes and pastes, reduced to what a single-line composer accepts.
 * Bracketed-paste markers are stripped, newlines become spaces, and every
 * other control character is dropped — the buffer must never hold a byte that
 * could break a rendered row. */
function composerText(data: string): string {
	return data
		.replaceAll("\x1b[200~", "")
		.replaceAll("\x1b[201~", "")
		.replace(/\r\n|\r|\n/g, " ")
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
}

function firstToolName(record: object): string | undefined {
	const content = (record as { message?: { content?: unknown } }).message?.content;
	if (!Array.isArray(content)) return undefined;
	for (const block of content) {
		if (typeof block === "object" && block !== null && (block as { type?: string }).type === "toolCall") {
			const name = (block as { name?: unknown }).name;
			if (typeof name === "string") return name;
		}
	}
	return undefined;
}

export class AgentHubComponent {
	private rows: RunRow[] = [];
	private readonly scanCache: ScanCache = new Map();
	private selectedKey: string | undefined;
	private listWindowTop = 0;
	/** Chat scroll as lines up from the bottom; 0 with follow = live tail. */
	private chatScroll = 0;
	private follow = true;
	private expandedTools = false;
	/** Per-record expand decisions layered over the global toggle. Generation
	 * bumps on every change so the memo can tell the layers apart. */
	private expandOverrides = new WeakMap<object, boolean>();
	private overrideGen = 0;
	private focusedRecord: object | undefined;
	private tail: SessionTail | undefined;
	private chatMemo: ChatMemo | undefined;
	private rpcInfo: FleetSnapshot = { available: false, entries: [] };
	private readonly rpc: SubagentsRpc;
	private listTimer: ReturnType<typeof setInterval> | undefined;
	private tailTimer: ReturnType<typeof setInterval> | undefined;
	private readonly offRunEvents: () => void;
	private lastSignature = "";
	private disposed = false;

	private mode: Mode = "nav";
	private composer = "";
	private searchInput = "";
	private searchQuery = "";
	/** Matched records held by object, not index — the tail trims from the
	 * front, and an index would silently drift onto a different record. */
	private searchMatches: object[] = [];
	private searchCursor = -1;
	private notice: Notice | undefined;
	private ackWatch: AckWatch | undefined;
	private liveOutput: OutputTail | undefined;
	private liveOutputFile: string | undefined;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		events: RpcEvents,
		private readonly done: (result: undefined) => void,
	) {
		this.rpc = new SubagentsRpc(events);
		this.refreshRuns();
		if (this.rows.length > 0) this.select(rowKey(this.rows[0]!));
		this.listTimer = setInterval(() => {
			this.refreshRuns();
			void this.refreshRpc();
		}, LIST_REFRESH_MS);
		this.tailTimer = setInterval(() => this.pollTail(), TAIL_POLL_MS);
		// A run finishing announces itself; reacting to the broadcast beats
		// waiting out the scan interval.
		this.offRunEvents = this.rpc.onRunEvents(() => {
			if (this.disposed) return;
			this.refreshRuns();
			void this.refreshRpc();
		});
		void this.refreshRpc();
	}

	// ── data ────────────────────────────────────────────────────────────────

	private refreshRuns(): void {
		if (this.disposed) return;
		this.rows = scanRuns(asyncRunsRoot(), this.scanCache);
		const wanted = this.rows.length > 0 ? rowKey(this.rows[0]!) : undefined;
		if (!this.rows.some(row => rowKey(row) === this.selectedKey)) {
			// Only when it actually changes: re-selecting `undefined` on an empty
			// root asked for a repaint every couple of seconds, forever.
			if (this.selectedKey !== wanted) this.select(wanted);
		} else {
			// The selected run may have moved to a session file it lacked at
			// selection time (spawn order writes status before the child exists).
			const row = this.selectedRow();
			if (row?.sessionFile && this.tail?.filePath !== row.sessionFile) this.attachTail(row);
		}
		const now = Date.now();
		const signature = `${this.rows.map(row => `${rowKey(row)}|${row.state}|${row.lastUpdate}|${row.currentTool}|${isStale(row, now)}`).join(";")}|rpc:${this.rpcInfo.available}:${this.rpcInfo.totalActive}`;
		if (signature !== this.lastSignature) {
			this.lastSignature = signature;
			this.tui.requestRender();
		}
	}

	private async refreshRpc(): Promise<void> {
		const fleet = await this.rpc.fleet();
		if (this.disposed) return;
		if (fleet.available) await this.rpc.identify();
		if (this.disposed) return;
		const changed = fleet.available !== this.rpcInfo.available || fleet.totalActive !== this.rpcInfo.totalActive;
		this.rpcInfo = fleet;
		if (changed) this.tui.requestRender();
	}

	private pollTail(): void {
		if (this.disposed) return;
		if (this.tail?.poll()) {
			this.chatMemo = undefined;
			this.tui.requestRender();
		}
		this.pollLiveOutput();
		this.pollAck();
		if (this.notice && Date.now() - this.notice.at > (this.notice.tone === "error" ? 10_000 : 6000)) {
			this.notice = undefined;
			this.tui.requestRender();
		}
	}

	/** The output log streams while the session file waits for the tool to
	 * finish — the one live signal a long tool call gives off. */
	private pollLiveOutput(): void {
		const row = this.selectedRow();
		const now = Date.now();
		const live = row !== undefined && row.state === "running" && !isStale(row, now) && this.follow;
		if (!live) {
			if (this.liveOutput !== undefined) {
				this.liveOutput = undefined;
				this.tui.requestRender();
			}
			return;
		}
		const stepLog = path.join(row.dir, `output-${row.stepIndex}.log`);
		const file = fs.existsSync(stepLog) ? stepLog : row.outputFile ? path.join(row.dir, row.outputFile) : undefined;
		this.liveOutputFile = file;
		const next = file ? readOutputTail(file, LIVE_OUTPUT_LINES, this.liveOutput) : undefined;
		if (next?.stamp !== this.liveOutput?.stamp) {
			this.liveOutput = next;
			this.tui.requestRender();
		}
	}

	private pollAck(): void {
		if (!this.ackWatch) return;
		const { runDir, index, requestId, sentAt } = this.ackWatch;
		const ack = findAck(runDir, index, requestId);
		if (ack) {
			this.ackWatch = undefined;
			if (ack.state === "delivered") this.setNotice("delivered to the child", "success");
			else if (ack.state === "queued") this.setNotice("queued — the child takes it between turns", "info");
			else this.setNotice(`steer failed: ${ack.message ?? "no reason given"}`, "error");
			return;
		}
		if (Date.now() - sentAt > ACK_WAIT_MS) {
			this.ackWatch = undefined;
			this.setNotice("no acknowledgment yet — it stays queued in the run's inbox", "info");
		}
	}

	private selectedRow(): RunRow | undefined {
		return this.rows.find(row => rowKey(row) === this.selectedKey);
	}

	private select(key: string | undefined): void {
		this.selectedKey = key;
		this.chatScroll = 0;
		this.follow = true;
		this.chatMemo = undefined;
		this.focusedRecord = undefined;
		this.searchMatches = [];
		this.searchCursor = -1;
		this.liveOutput = undefined;
		const row = this.selectedRow();
		if (row?.sessionFile) this.attachTail(row);
		else this.tail = undefined;
		this.tui.requestRender();
	}

	private attachTail(row: RunRow): void {
		this.tail = new SessionTail(row.sessionFile!);
		this.tail.poll();
		this.chatMemo = undefined;
	}

	private setNotice(text: string, tone: Notice["tone"]): void {
		this.notice = { text, tone, at: Date.now() };
		this.tui.requestRender();
	}

	// ── actions ─────────────────────────────────────────────────────────────

	/** Whether the bridge in this pi owns the run. Control is session-scoped
	 * upstream: acting on another session's run is refused with not_found, so
	 * the hub says "view-only" up front instead of relaying that riddle.
	 * Unknown ownership (no bridge, or no session learned yet) returns
	 * undefined and the action is attempted rather than pre-refused. */
	private ownsRun(row: RunRow): boolean | undefined {
		if (!this.rpcInfo.available || this.rpc.sessionId === undefined || row.sessionId === undefined) return undefined;
		return row.sessionId === this.rpc.sessionId;
	}

	/** Which channel a message to this run takes. A fresh running run can be
	 * steered; anything else — finished, failed, or recorded running by a
	 * parent that died — is a resume, which revives the child. */
	private channelFor(row: RunRow, now: number): "steer" | "resume" {
		return row.state === "running" && !isStale(row, now) ? "steer" : "resume";
	}

	private async sendMessage(row: RunRow, text: string): Promise<void> {
		const target = { id: row.runId, ...(row.stepCount > 1 ? { index: row.stepIndex } : {}) };
		const owns = this.ownsRun(row);
		if (this.channelFor(row, Date.now()) === "steer") {
			const live = runnerReachable(readCapability(row.dir, row.stepIndex)) && !steerInboxClosed(row.dir);
			if (owns === false) {
				// The bridge will refuse a foreign run; its runner's file inbox
				// is the sanctioned cross-process channel when one is alive.
				if (live) {
					try {
						const requestId = writeSteerRequestFile(row.dir, text, row.stepIndex);
						this.ackWatch = { runDir: row.dir, index: row.stepIndex, requestId, sentAt: Date.now() };
						this.setNotice("dropped in the runner's inbox — waiting for the ack…", "info");
					} catch (error) {
						this.setNotice(error instanceof Error ? error.message : String(error), "error");
					}
				} else {
					this.setNotice("view-only: this run belongs to another pi session and has no live runner", "error");
				}
				return;
			}
			const outcome = await this.rpc.steer(target, text);
			if (this.disposed) return;
			if (outcome.ok) {
				if (live) {
					// No ack watch on this path: the owning extension consumes ack
					// files itself (read-and-delete), so a watcher here races the
					// owner and loses — delivery shows up as the child reacting.
					this.setNotice("steering — the runner delivers it between turns", "success");
				} else {
					// Honest label for the attached case: the inbox holds it, and
					// nothing reads that inbox until the run is resumed.
					this.setNotice("accepted · parked — delivers when this run is resumed", "info");
				}
			} else if (outcome.unreachable && live) {
				// No bridge in this pi, but a live detached runner owns the run:
				// its file inbox exists exactly for this.
				try {
					const requestId = writeSteerRequestFile(row.dir, text, row.stepIndex);
					this.ackWatch = { runDir: row.dir, index: row.stepIndex, requestId, sentAt: Date.now() };
					this.setNotice("dropped in the runner's inbox — waiting for the ack…", "info");
				} catch (error) {
					this.setNotice(error instanceof Error ? error.message : String(error), "error");
				}
			} else if (outcome.unreachable) {
				this.setNotice("no live channel: the subagents extension is not answering and no runner owns this run", "error");
			} else {
				this.setNotice(outcome.text || "steer rejected", "error");
			}
			return;
		}
		if (owns === false) {
			this.setNotice("view-only: only the pi session that launched this run can resume it", "error");
			return;
		}
		const outcome = await this.rpc.resume(target, text);
		if (this.disposed) return;
		if (outcome.ok) {
			this.setNotice("resuming — the child answers here as it works", "success");
			this.refreshRuns();
		} else if (outcome.unreachable) {
			this.setNotice("resume needs the subagents extension in this session", "error");
		} else {
			this.setNotice(outcome.text || "resume rejected", "error");
		}
	}

	private async interruptRun(row: RunRow): Promise<void> {
		if (this.channelFor(row, Date.now()) !== "steer") {
			this.setNotice("nothing to interrupt — this run is not live", "error");
			return;
		}
		if (this.ownsRun(row) === false) {
			if (runnerReachable(readCapability(row.dir, row.stepIndex))) {
				try {
					writeControlRequest(row.dir, "interrupt", "requested from pi-agent-hub");
					this.setNotice("interrupt dropped in the runner's inbox", "info");
				} catch (error) {
					this.setNotice(error instanceof Error ? error.message : String(error), "error");
				}
			} else {
				this.setNotice("view-only: this run belongs to another pi session", "error");
			}
			return;
		}
		const outcome = await this.rpc.interrupt({ id: row.runId, ...(row.stepCount > 1 ? { index: row.stepIndex } : {}) });
		if (this.disposed) return;
		if (outcome.ok) this.setNotice(outcome.text || "interrupt requested", "success");
		else if (outcome.unreachable && runnerReachable(readCapability(row.dir, row.stepIndex))) {
			try {
				writeControlRequest(row.dir, "interrupt", "requested from pi-agent-hub");
				this.setNotice("interrupt dropped in the runner's inbox", "info");
			} catch (error) {
				this.setNotice(error instanceof Error ? error.message : String(error), "error");
			}
		} else this.setNotice(outcome.unreachable ? "no channel to interrupt this run" : outcome.text, "error");
	}

	private async stopRun(row: RunRow): Promise<void> {
		if (this.ownsRun(row) === false) {
			if (runnerReachable(readCapability(row.dir, row.stepIndex))) {
				try {
					writeControlRequest(row.dir, "stop", "requested from pi-agent-hub");
					this.setNotice("stop dropped in the runner's inbox", "info");
				} catch (error) {
					this.setNotice(error instanceof Error ? error.message : String(error), "error");
				}
			} else {
				this.setNotice("view-only: this run belongs to another pi session", "error");
			}
			return;
		}
		const outcome = await this.rpc.stop({ id: row.runId });
		if (this.disposed) return;
		if (outcome.ok) {
			this.setNotice(outcome.text || "stop requested", "success");
			this.refreshRuns();
		} else if (outcome.unreachable && runnerReachable(readCapability(row.dir, row.stepIndex))) {
			try {
				writeControlRequest(row.dir, "stop", "requested from pi-agent-hub");
				this.setNotice("stop dropped in the runner's inbox", "info");
			} catch (error) {
				this.setNotice(error instanceof Error ? error.message : String(error), "error");
			}
		} else this.setNotice(outcome.unreachable ? "no channel to stop this run" : outcome.text, "error");
	}

	/** Open the child's cwd / copy its session path. User-invoked one-shots;
	 * failure is a notice, never a throw. */
	private openCwd(row: RunRow): void {
		if (!row.cwd) return this.setNotice("this run recorded no working directory", "error");
		const opener = process.platform === "darwin" ? "open" : "xdg-open";
		try {
			child_process.spawn(opener, [row.cwd], { detached: true, stdio: "ignore" }).unref();
			this.setNotice(`opening ${row.cwd}`, "info");
		} catch (error) {
			this.setNotice(`could not open: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	}

	private copySessionPath(row: RunRow): void {
		if (!row.sessionFile) return this.setNotice("this run recorded no session file", "error");
		const tool = process.platform === "darwin" ? "pbcopy" : "xclip";
		const args = process.platform === "darwin" ? [] : ["-selection", "clipboard"];
		try {
			const proc = child_process.spawn(tool, args, { stdio: ["pipe", "ignore", "ignore"] });
			proc.on("error", () => this.setNotice(`copy failed (${tool} not available)`, "error"));
			proc.stdin.end(row.sessionFile);
			this.setNotice("session path copied", "success");
		} catch (error) {
			this.setNotice(`copy failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	}

	// ── search ──────────────────────────────────────────────────────────────

	private runSearch(query: string): void {
		this.searchQuery = query;
		this.searchMatches = [];
		this.searchCursor = -1;
		if (!this.tail || !query) return;
		const needle = query.toLowerCase();
		const records = this.tail.records as object[];
		for (let index = 0; index < records.length; index++) {
			const record = records[index]!;
			if (!recordPlainText(record).toLowerCase().includes(needle)) continue;
			const message = (record as { message?: { role?: string; toolCallId?: string } }).message;
			if (message?.role === "toolResult") {
				// A result renders inside the assistant group that called it, so
				// that group is the jump target.
				const owner = this.ownerOfResult(records, index, message.toolCallId);
				if (owner && !this.searchMatches.includes(owner)) this.searchMatches.push(owner);
			} else if (!this.searchMatches.includes(record)) {
				this.searchMatches.push(record);
			}
		}
		if (this.searchMatches.length === 0) {
			this.setNotice(`no match for "${query}"`, "info");
			return;
		}
		this.jumpToMatch(this.searchMatches.length - 1);
	}

	private ownerOfResult(records: object[], resultIndex: number, toolCallId: string | undefined): object | undefined {
		if (typeof toolCallId !== "string") return undefined;
		for (let index = resultIndex; index >= 0; index--) {
			const content = (records[index] as { message?: { role?: string; content?: unknown } }).message?.content;
			if (!Array.isArray(content)) continue;
			if (content.some(block => typeof block === "object" && block !== null && (block as { id?: string }).id === toolCallId)) return records[index];
		}
		return undefined;
	}

	private jumpToMatch(cursor: number): void {
		if (!this.tail || this.searchMatches.length === 0) return;
		this.searchCursor = ((cursor % this.searchMatches.length) + this.searchMatches.length) % this.searchMatches.length;
		const record = this.searchMatches[this.searchCursor]!;
		const recordIndex = (this.tail.records as object[]).indexOf(record);
		if (recordIndex === -1) {
			// Trimmed out from under the match set.
			this.searchMatches.splice(this.searchCursor, 1);
			if (this.searchMatches.length > 0) this.jumpToMatch(this.searchCursor);
			else this.setNotice("match no longer retained", "info");
			return;
		}
		const offset = bottomOffsetOfRecord(this.tail, recordIndex, this.lastChatWidth || 80, this.chatOptions());
		if (offset === undefined) return;
		this.chatScroll = Math.max(0, offset - this.lastChatHeight);
		this.follow = this.chatScroll === 0;
		this.chatMemo = undefined;
		this.setNotice(`match ${this.searchCursor + 1}/${this.searchMatches.length} · n older · N newer`, "info");
	}

	// ── input ───────────────────────────────────────────────────────────────

	handleInput(data: string): void {
		if (this.mode === "compose" || this.mode === "search") return this.handleEditingInput(data);
		if (this.mode === "confirmStop") {
			this.mode = "nav";
			if (data === "D") {
				const row = this.selectedRow();
				if (row) void this.stopRun(row);
			} else {
				this.setNotice("stop cancelled", "info");
			}
			this.tui.requestRender();
			return;
		}
		if (data === "q" || data === "\x1b" || data === "\x03") {
			this.done(undefined);
			return;
		}
		const index = this.rows.findIndex(row => rowKey(row) === this.selectedKey);
		if (data === "\x1b[A" || data === "k") {
			if (index > 0) this.select(rowKey(this.rows[index - 1]!));
			return;
		}
		if (data === "\x1b[B" || data === "j") {
			if (index >= 0 && index < this.rows.length - 1) this.select(rowKey(this.rows[index + 1]!));
			return;
		}
		if (data === "K") return this.scrollChat(1);
		if (data === "J") return this.scrollChat(-1);
		if (data === "\x1b[5~") return this.scrollChat(this.lastChatHeight);
		if (data === "\x1b[6~") return this.scrollChat(-this.lastChatHeight);
		if (data === "G" || data === "\x1b[F" || data === "\x1b[4~") {
			this.follow = true;
			this.chatScroll = 0;
			this.tui.requestRender();
			return;
		}
		// `t` rather than Tab as the primary binding: the host TUI consumes Tab
		// before an overlay sees it. The Tab codes stay as aliases for terminals
		// that do forward them.
		if (data === "t" || data === "\t") return this.stepToolFocus(-1);
		if (data === "T" || data === "\x1b[Z") return this.stepToolFocus(1);
		if (data === "x" || data === "X" || data === "\x0f") {
			if (data !== "X" && this.focusedRecord) {
				const effective = this.expandOverrides.get(this.focusedRecord) ?? this.expandedTools;
				this.expandOverrides.set(this.focusedRecord, !effective);
			} else {
				this.expandedTools = !this.expandedTools;
				this.expandOverrides = new WeakMap();
			}
			this.overrideGen++;
			this.chatMemo = undefined;
			this.tui.requestRender();
			return;
		}
		if (data === "s" || data === "\r") {
			if (this.selectedRow()) {
				this.mode = "compose";
				this.tui.requestRender();
			}
			return;
		}
		if (data === "/") {
			this.mode = "search";
			this.searchInput = "";
			this.tui.requestRender();
			return;
		}
		if (data === "n" || data === "N") {
			if (this.searchMatches.length > 0) this.jumpToMatch(this.searchCursor + (data === "n" ? -1 : 1));
			return;
		}
		if (data === "i") {
			const row = this.selectedRow();
			if (row) void this.interruptRun(row);
			return;
		}
		if (data === "D") {
			if (this.selectedRow()) {
				this.mode = "confirmStop";
				this.tui.requestRender();
			}
			return;
		}
		if (data === "o") {
			const row = this.selectedRow();
			if (row) this.openCwd(row);
			return;
		}
		if (data === "y") {
			const row = this.selectedRow();
			if (row) this.copySessionPath(row);
			return;
		}
		if (data === "r" || data === "R") {
			this.scanCache.clear();
			this.lastSignature = "";
			this.refreshRuns();
			void this.refreshRpc();
			return;
		}
	}

	private handleEditingInput(data: string): void {
		const composing = this.mode === "compose";
		if (data === "\x1b" || data === "\x03") {
			this.mode = "nav";
			this.tui.requestRender();
			return;
		}
		if (data === "\r" || data === "\n") {
			if (composing) {
				const row = this.selectedRow();
				const text = this.composer.trim();
				this.mode = "nav";
				this.composer = "";
				if (row && text) void this.sendMessage(row, text);
			} else {
				this.mode = "nav";
				this.runSearch(this.searchInput.trim());
			}
			this.tui.requestRender();
			return;
		}
		if (data === "\x7f" || data === "\x08") {
			if (composing) this.composer = [...this.composer].slice(0, -1).join("");
			else this.searchInput = [...this.searchInput].slice(0, -1).join("");
			this.tui.requestRender();
			return;
		}
		if (data === "\x15") {
			if (composing) this.composer = "";
			else this.searchInput = "";
			this.tui.requestRender();
			return;
		}
		const text = composerText(data);
		if (!text) return;
		if (composing) {
			this.composer = (this.composer + text).slice(0, COMPOSER_MAX_CHARS);
			if (this.composer.length === COMPOSER_MAX_CHARS) this.setNotice("message is at the 8000-character cap", "info");
		} else {
			this.searchInput = (this.searchInput + text).slice(0, 200);
		}
		this.tui.requestRender();
	}

	private stepToolFocus(direction: -1 | 1): void {
		const groups = (this.chatMemo?.groups ?? []).filter(group => group.hasTools);
		if (groups.length === 0) {
			this.focusedRecord = undefined;
			this.setNotice("no tool group in view — scroll to one first", "info");
			return;
		}
		const order = groups.map(group => group.record);
		const current = this.focusedRecord ? order.indexOf(this.focusedRecord) : -1;
		let next: number;
		if (current === -1) {
			next = direction === -1 ? order.length - 1 : 0;
		} else {
			next = current + direction;
		}
		this.focusedRecord = next < 0 || next >= order.length ? undefined : order[next];
		this.tui.requestRender();
	}

	private lastChatHeight = 10;
	private lastChatWidth = 0;

	/** Scroll is only ever adjusted here; the clamp belongs to render, which is
	 * the one place that knows how many lines exist. Clamping here against a
	 * memo that a tail poll may have just cleared read as "jump to the live
	 * tail", so a reader scrolled back through a growing conversation was
	 * yanked to the bottom every time the child spoke. */
	private scrollChat(delta: number): void {
		this.chatScroll = Math.max(0, this.chatScroll + delta);
		this.follow = this.chatScroll === 0;
		this.chatMemo = undefined;
		this.tui.requestRender();
	}

	// ── render ──────────────────────────────────────────────────────────────

	render(width: number): string[] {
		const now = Date.now();
		const dim = (text: string): string => this.theme.fg("dim", text);
		const border = (text: string): string => this.theme.fg("borderMuted", text);
		const terminalRows = (this.tui as unknown as { terminal?: { rows?: number } }).terminal?.rows ?? 40;
		const height = Math.max(14, Math.min(Math.floor(terminalRows * 0.85) - 2, terminalRows - 4));
		// The panel draws its own frame — the overlay paints no border of its
		// own, and unframed rows read as text floating over the app.
		const innerWidth = Math.max(40, width - 4);
		// Title, body, the action row, bottom border.
		const bodyHeight = height - 3;
		this.lastChatHeight = Math.max(1, bodyHeight - 2);
		const listWidth = Math.min(38, Math.max(24, Math.floor(innerWidth * 0.28)));
		const chatWidth = Math.max(20, innerWidth - listWidth - 3);

		const pad = (text: string, target: number): string => {
			const clipped = truncateToWidth(text, target);
			const deficit = target - visibleWidth(clipped);
			return deficit > 0 ? clipped + " ".repeat(deficit) : clipped;
		};

		// The two numbers count different populations and must say so. The run
		// count is the scan of this machine's shared artifact root — every pi
		// session this user has run. The active count comes from the subagents
		// bridge, which reports only the session we are inside, foreground
		// delegations included. Printed side by side without their scopes they
		// read as a contradiction whenever either is non-zero on its own.
		const runs = `${this.rows.length} run${this.rows.length === 1 ? "" : "s"} on this machine`;
		const link = !this.rpcInfo.available
			? dim("· subagents not answering")
			: this.rpcInfo.totalActive === undefined
				? this.theme.fg("success", "· linked")
				: this.theme.fg("success", `· ${this.rpcInfo.totalActive} active in this session`);
		const title = ` ${this.theme.bold("Agent hub")} ${dim(`· ${runs} `)}${link} `;
		const hints = ` ${dim(this.bottomHints())} `;

		const frameRow = (content: string, left: string, right: string): string => {
			const fill = Math.max(0, width - left.length - right.length - visibleWidth(content));
			return truncateToWidth(`${border(left)}${content}${border("─".repeat(fill))}${border(right)}`, width);
		};

		const lines: string[] = [frameRow(truncateToWidth(title, width - 4), "╭─", "╮")];
		const listLines = this.renderList(listWidth, bodyHeight, now);
		const chatLines = this.renderChat(chatWidth, bodyHeight);
		const separator = border("│");
		for (let index = 0; index < bodyHeight; index++) {
			const inner = `${pad(listLines[index] ?? "", listWidth)} ${separator} ${pad(chatLines[index] ?? "", chatWidth)}`;
			lines.push(truncateToWidth(`${border("│")} ${pad(inner, width - 4)} ${border("│")}`, width));
		}
		lines.push(truncateToWidth(`${border("│")} ${pad(this.renderActionRow(innerWidth, now), width - 4)} ${border("│")}`, width));
		lines.push(frameRow(truncateToWidth(hints, width - 4), "╰─", "╯"));
		return lines;
	}

	private bottomHints(): string {
		if (this.mode === "compose") return "enter send · esc cancel · ctrl+u clear";
		if (this.mode === "search") return "enter find · esc cancel";
		if (this.mode === "confirmStop") return "D confirm stop · any other key cancels";
		return "↑/↓ select · J/K scroll · G follow · t tool · x expand · s message · i interrupt · D stop · / find · q close";
	}

	/** The row under the panes: the composer when typing, otherwise the latest
	 * action's outcome, the focused tool, or what the composer would do. */
	private renderActionRow(width: number, now: number): string {
		const dim = (text: string): string => this.theme.fg("dim", text);
		const row = this.selectedRow();
		if (this.mode === "compose" || this.mode === "search") {
			const composing = this.mode === "compose";
			const channel = composing && row ? this.channelFor(row, now) : undefined;
			const label = composing ? `${channel} → ${row?.agent ?? "?"}` : "find";
			const buffer = composing ? this.composer : this.searchInput;
			const prompt = `${this.theme.fg("accent", label)} ${dim("›")} `;
			const room = Math.max(8, width - visibleWidth(prompt) - 2);
			let shown = buffer.length > room * 2 ? buffer.slice(-room * 2) : buffer;
			while (visibleWidth(shown) > room) shown = `…${shown.slice(2)}`;
			return `${prompt}${shown}${this.theme.fg("accent", "▌")}`;
		}
		if (this.mode === "confirmStop") {
			return this.theme.fg("error", `⚠ stop ${row?.agent ?? "this run"} (${row?.runId.slice(0, 8) ?? "?"})? press D again to confirm`);
		}
		if (this.notice) {
			const tone = this.notice.tone === "error" ? "error" : this.notice.tone === "success" ? "success" : "dim";
			return this.theme.fg(tone, this.notice.text);
		}
		if (this.focusedRecord) {
			const name = firstToolName(this.focusedRecord) ?? "tools";
			return dim(`focused ⟨${name}⟩ · x expand/collapse · t next · T back`);
		}
		if (row) {
			const channel = this.channelFor(row, now);
			if (this.ownsRun(row) === false && !(channel === "steer" && runnerReachable(readCapability(row.dir, row.stepIndex)))) {
				return dim("view-only · launched by another pi session · o cwd · y copy path");
			}
			const explain = channel === "steer" ? "s steers the running child" : row.state === "running" ? "s revives this stalled run" : "s resumes the conversation";
			return dim(`${explain} · i interrupt · D stop · o cwd · y copy path`);
		}
		return dim("no run selected");
	}

	private stateGlyph(row: RunRow, now: number): string {
		if (isStale(row, now)) return this.theme.fg("muted", "●");
		if (row.state === "running") return this.theme.fg("warning", "●");
		if (row.state === "complete") return this.theme.fg("success", "✓");
		if (row.state === "failed") return this.theme.fg("error", "✗");
		return this.theme.fg("muted", "■");
	}

	private renderList(width: number, fullHeight: number, now: number): string[] {
		// Reserve the notice's row up front. Overwriting the last row instead
		// erased the selection when the cursor was on it — the list lost its
		// cursor entirely at the moment the notice appeared.
		const capped = this.rows.length === MAX_ROWS;
		const height = Math.max(1, capped ? fullHeight - 1 : fullHeight);
		if (this.rows.length === 0) {
			return [this.theme.fg("dim", "no runs found"), this.theme.fg("dim", "launch a background agent"), this.theme.fg("dim", "and it appears here")];
		}
		const selectedIndex = Math.max(0, this.rows.findIndex(row => rowKey(row) === this.selectedKey));
		if (selectedIndex < this.listWindowTop) this.listWindowTop = selectedIndex;
		if (selectedIndex >= this.listWindowTop + height) this.listWindowTop = selectedIndex - height + 1;
		this.listWindowTop = Math.max(0, Math.min(this.listWindowTop, Math.max(0, this.rows.length - height)));

		const lines: string[] = [];
		for (let index = this.listWindowTop; index < Math.min(this.rows.length, this.listWindowTop + height); index++) {
			const row = this.rows[index]!;
			const selected = index === selectedIndex;
			const marker = selected ? this.theme.fg("accent", "▸") : " ";
			const stale = isStale(row, now);
			const age = formatAge(row.lastActivityAt ?? row.lastUpdate, now);
			const detail = stale ? "stale" : row.state === "running" ? (row.currentTool ?? "…") : row.state;
			const step = row.stepCount > 1 ? `#${row.stepIndex} ` : "";
			const name = selected ? this.theme.bold(row.agent) : row.agent;
			lines.push(truncateToWidth(`${marker}${this.stateGlyph(row, now)} ${name} ${this.theme.fg("dim", `${step}· ${detail}${age ? ` · ${age}` : ""}`)}`, width));
		}
		// Inside the budget, not appended past it: a line beyond the frame's
		// height is cropped and the notice never reaches the reader.
		if (capped) {
			while (lines.length < height) lines.push("");
			lines.push(this.theme.fg("dim", `showing newest ${MAX_ROWS} · r to rescan`));
		}
		return lines;
	}

	private chatOptions() {
		return {
			tui: this.tui,
			cwd: this.selectedRow()?.cwd ?? process.cwd(),
			expandedTools: this.expandedTools,
			expandedFor: (record: object) => this.expandOverrides.get(record) ?? this.expandedTools,
			dim: (text: string): string => this.theme.fg("dim", text),
			viewHeight: this.lastChatHeight,
			scroll: this.chatScroll,
		};
	}

	private renderChat(width: number, height: number): string[] {
		const row = this.selectedRow();
		if (!row) return [this.theme.fg("dim", "nothing selected")];
		const dim = (text: string): string => this.theme.fg("dim", text);
		const now = Date.now();

		// A position counted in wrapped lines does not survive a change of wrap
		// width — line 3876 at one width is a different place at another, so
		// carrying the number over states something untrue. Returning to the
		// tail also spares a resize the full walk back down to a deep offset,
		// which a drag would otherwise pay once per column.
		if (width !== this.lastChatWidth) {
			this.lastChatWidth = width;
			if (this.chatScroll !== 0) {
				this.chatScroll = 0;
				this.follow = true;
				this.chatMemo = undefined;
			}
		}

		// The same verdict the list row shows. Interpolating the recorded state
		// raw claimed "running" for a run whose heartbeat had stopped, one
		// column away from a row already calling it stale.
		const stale = isStale(row, now);
		const state = stale ? "stale" : row.state;
		const header = `${this.theme.fg("toolTitle", this.theme.bold(row.agent))} ${dim(`· ${state}${row.model ? ` · ${row.model}` : ""} · ${row.runId.slice(0, 8)}`)}`;
		const paneHeight = Math.max(1, height - 2);
		// One row is reserved for the scroll indicator, and a block for the live
		// output tail — reserved, not overwritten, so neither costs content.
		const liveLines = this.follow && !stale && row.state === "running" ? (this.liveOutput?.lines ?? []) : [];
		const reserved = (this.chatScroll > 0 ? 1 : 0) + (liveLines.length > 0 ? liveLines.length + 1 : 0);
		const viewHeight = Math.max(1, paneHeight - reserved);
		this.lastChatHeight = viewHeight;
		const body: string[] = [];

		if (!this.tail) {
			body.push(dim("this run recorded no session file"));
		} else if (!this.tail.fileExists) {
			body.push(dim("its session file is no longer on disk"));
			body.push(dim("(retention may have pruned it)"));
		} else {
			const liveStamp = liveLines.length > 0 ? (this.liveOutput?.stamp ?? "") : "";
			const memoValid =
				this.chatMemo !== undefined &&
				this.chatMemo.width === width &&
				this.chatMemo.height === viewHeight &&
				this.chatMemo.expandedTools === this.expandedTools &&
				this.chatMemo.overrideGen === this.overrideGen &&
				this.chatMemo.scroll === this.chatScroll &&
				this.chatMemo.liveStamp === liveStamp &&
				this.chatMemo.recordCount === this.tail.records.length &&
				this.chatMemo.truncatedHead === this.tail.truncatedHead;
			if (!memoValid) {
				const built = buildChatWindow(this.tail, width, { ...this.chatOptions(), viewHeight, scroll: this.chatScroll });
				// Render owns the clamp: the walk stops at the oldest retained
				// record, and only it knows where that is.
				const maxScroll = built.atOldest ? Math.max(0, built.linesKnown - viewHeight) : this.chatScroll;
				if (this.chatScroll > maxScroll) {
					this.chatScroll = maxScroll;
					this.follow = this.chatScroll === 0;
				}
				this.chatMemo = {
					recordCount: this.tail.records.length,
					truncatedHead: this.tail.truncatedHead,
					width,
					height: viewHeight,
					expandedTools: this.expandedTools,
					overrideGen: this.overrideGen,
					scroll: this.chatScroll,
					liveStamp,
					lines: built.lines,
					linesKnown: built.linesKnown,
					atOldest: built.atOldest,
					groups: built.groups,
				};
				if (this.focusedRecord && !built.groups.some(group => group.record === this.focusedRecord)) {
					// The focused group scrolled out of the window; a focus the
					// reader cannot see is a focus x acts on invisibly.
					this.focusedRecord = undefined;
				}
			}
			body.push(...this.chatMemo!.lines);
			if (this.chatMemo!.lines.length === 0) {
				body.push(dim(stale ? "no conversation recorded — s revives this run" : "no conversation recorded yet"));
			}
		}

		const filled = [...body];
		while (filled.length < viewHeight) filled.push("");
		const view = filled.slice(0, viewHeight);
		if (this.chatScroll > 0) view.push(truncateToWidth(dim(`↓ ${this.chatScroll} newer lines · G to follow`), width));
		if (liveLines.length > 0) {
			view.push(truncateToWidth(dim(`┈ live output (${path.basename(this.liveOutputFile ?? "output")})`), width));
			for (const line of liveLines) view.push(truncateToWidth(dim(line), width));
		}
		while (view.length < paneHeight) view.push("");
		return [truncateToWidth(header, width), "", ...view.slice(0, paneHeight)];
	}

	invalidate(): void {
		this.chatMemo = undefined;
	}

	dispose(): void {
		this.disposed = true;
		if (this.listTimer) clearInterval(this.listTimer);
		if (this.tailTimer) clearInterval(this.tailTimer);
		this.offRunEvents();
		this.rpc.dispose();
	}
}

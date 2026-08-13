// The hub overlay: a roster of background agents on the left, the selected
// child's conversation on the right, live. Read-only in v0 — the composer and
// controls arrive with v1.
import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { asyncRunsRoot, isStale, MAX_ROWS, rowKey, scanRuns, type RunRow, type ScanCache } from "./runs.ts";
import { SubagentsRpc, type FleetSnapshot, type RpcEvents } from "./rpc.ts";
import { buildChatWindow, SessionTail } from "./session-view.ts";

const LIST_REFRESH_MS = 2000;
const TAIL_POLL_MS = 500;

interface ChatMemo {
	recordCount: number;
	truncatedHead: boolean;
	width: number;
	height: number;
	expandedTools: boolean;
	scroll: number;
	lines: string[];
	linesKnown: number;
	atOldest: boolean;
}

function formatAge(from: number | undefined, now: number): string {
	if (!from) return "";
	const seconds = Math.max(0, Math.round((now - from) / 1000));
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
	if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
	return `${Math.round(seconds / 86400)}d`;
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
	private tail: SessionTail | undefined;
	private chatMemo: ChatMemo | undefined;
	private rpcInfo: FleetSnapshot = { available: false, entries: [] };
	private readonly rpc: SubagentsRpc;
	private listTimer: ReturnType<typeof setInterval> | undefined;
	private tailTimer: ReturnType<typeof setInterval> | undefined;
	private lastSignature = "";
	private disposed = false;

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
		const changed = fleet.available !== this.rpcInfo.available || fleet.totalActive !== this.rpcInfo.totalActive;
		this.rpcInfo = fleet;
		if (changed) this.tui.requestRender();
	}

	private pollTail(): void {
		if (this.disposed || !this.tail) return;
		if (this.tail.poll()) {
			this.chatMemo = undefined;
			this.tui.requestRender();
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

	// ── input ───────────────────────────────────────────────────────────────

	handleInput(data: string): void {
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
		if (data === "x" || data === "X" || data === "\x0f") {
			this.expandedTools = !this.expandedTools;
			this.chatMemo = undefined;
			this.tui.requestRender();
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
		const height = Math.max(12, Math.min(Math.floor(terminalRows * 0.85) - 2, terminalRows - 4));
		// The panel draws its own frame — the overlay paints no border of its
		// own, and unframed rows read as text floating over the app.
		const innerWidth = Math.max(40, width - 4);
		const bodyHeight = height - 2;
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
		const hints = ` ${dim("↑/↓ select · J/K/PgUp/PgDn scroll · G follow · x expand · r rescan · q close")} `;

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
		lines.push(frameRow(truncateToWidth(hints, width - 4), "╰─", "╯"));
		return lines;
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
		const state = isStale(row, now) ? "stale" : row.state;
		const header = `${this.theme.fg("toolTitle", this.theme.bold(row.agent))} ${dim(`· ${state}${row.model ? ` · ${row.model}` : ""} · ${row.runId.slice(0, 8)}`)}`;
		// One row is reserved for the indicator when scrolled, rather than the
		// indicator overwriting content: the reader loses nothing for the
		// privilege of being told where they are.
		const paneHeight = Math.max(1, height - 2);
		const viewHeight = Math.max(1, this.chatScroll > 0 ? paneHeight - 1 : paneHeight);
		const body: string[] = [];

		if (!this.tail) {
			body.push(dim("this run recorded no session file"));
		} else if (!this.tail.fileExists) {
			body.push(dim("its session file is no longer on disk"));
			body.push(dim("(retention may have pruned it)"));
		} else {
			const memoValid =
				this.chatMemo !== undefined &&
				this.chatMemo.width === width &&
				this.chatMemo.height === viewHeight &&
				this.chatMemo.expandedTools === this.expandedTools &&
				this.chatMemo.scroll === this.chatScroll &&
				this.chatMemo.recordCount === this.tail.records.length &&
				this.chatMemo.truncatedHead === this.tail.truncatedHead;
			if (!memoValid) {
				const built = buildChatWindow(this.tail, width, {
					tui: this.tui,
					cwd: row.cwd ?? process.cwd(),
					expandedTools: this.expandedTools,
					dim,
					viewHeight,
					scroll: this.chatScroll,
				});
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
					scroll: this.chatScroll,
					lines: built.lines,
					linesKnown: built.linesKnown,
					atOldest: built.atOldest,
				};
			}
			body.push(...this.chatMemo!.lines);
			if (this.chatMemo!.lines.length === 0) body.push(dim("no conversation recorded yet"));
		}

		// The pane is exactly `height` lines: header, a blank, then the body.
		// A notice appended past that budget was cropped by the frame, so the
		// one state that needed it — scrolled away from the tail — was the one
		// state that never showed it.
		const filled = [...body];
		while (filled.length < viewHeight) filled.push("");
		const view = filled.slice(0, viewHeight);
		if (this.chatScroll > 0) view.push(truncateToWidth(dim(`↓ ${this.chatScroll} newer lines · G to follow`), width));
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
		this.rpc.dispose();
	}
}

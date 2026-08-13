// The hub overlay: a roster of background agents on the left, the selected
// child's conversation on the right, live. Read-only in v0 — the composer and
// controls arrive with v1.
import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { asyncRunsRoot, isStale, MAX_ROWS, rowKey, scanRuns, type RunRow, type ScanCache } from "./runs.ts";
import { SubagentsRpc, type FleetSnapshot, type RpcEvents } from "./rpc.ts";
import { buildChatLines, SessionTail } from "./session-view.ts";

const LIST_REFRESH_MS = 2000;
const TAIL_POLL_MS = 500;

interface ChatMemo {
	recordCount: number;
	truncatedHead: boolean;
	width: number;
	expandedTools: boolean;
	lines: string[];
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
		if (this.selectedKey === undefined || !this.rows.some(row => rowKey(row) === this.selectedKey)) {
			this.select(this.rows.length > 0 ? rowKey(this.rows[0]!) : undefined);
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

	private scrollChat(delta: number): void {
		const total = this.chatMemo?.lines.length ?? 0;
		const max = Math.max(0, total - this.lastChatHeight);
		this.chatScroll = Math.min(max, Math.max(0, this.chatScroll + delta));
		this.follow = this.chatScroll === 0;
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

		const active = this.rpcInfo.available && this.rpcInfo.totalActive !== undefined ? ` · ${this.rpcInfo.totalActive} active` : "";
		const rpcBadge = this.rpcInfo.available ? this.theme.fg("success", `rpc ✓${active}`) : dim("rpc –");
		const title = ` ${this.theme.bold("Agent hub")} ${dim(`· ${this.rows.length} runs ·`)} ${rpcBadge} `;
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

	private renderList(width: number, height: number, now: number): string[] {
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
		if (this.rows.length === MAX_ROWS) lines.push(this.theme.fg("dim", `showing newest ${MAX_ROWS}`));
		return lines;
	}

	private renderChat(width: number, height: number): string[] {
		const row = this.selectedRow();
		if (!row) return [this.theme.fg("dim", "nothing selected")];
		const dim = (text: string): string => this.theme.fg("dim", text);

		const header = `${this.theme.fg("toolTitle", this.theme.bold(row.agent))} ${dim(`· ${row.state}${row.model ? ` · ${row.model}` : ""} · ${row.runId.slice(0, 8)}`)}`;
		const body: string[] = [];
		if (!this.tail) {
			body.push(dim("this run recorded no session file"));
			body.push(dim("nothing to read yet"));
		} else {
			const memoValid =
				this.chatMemo !== undefined &&
				this.chatMemo.width === width &&
				this.chatMemo.expandedTools === this.expandedTools &&
				this.chatMemo.recordCount === this.tail.records.length &&
				this.chatMemo.truncatedHead === this.tail.truncatedHead;
			if (!memoValid) {
				this.chatMemo = {
					recordCount: this.tail.records.length,
					truncatedHead: this.tail.truncatedHead,
					width,
					expandedTools: this.expandedTools,
					lines: buildChatLines(this.tail, width, {
						tui: this.tui,
						cwd: row.cwd ?? process.cwd(),
						expandedTools: this.expandedTools,
						dim,
					}),
				};
			}
			const all = this.chatMemo!.lines;
			const viewHeight = height - 2;
			const maxScroll = Math.max(0, all.length - viewHeight);
			if (this.follow) this.chatScroll = 0;
			const scroll = Math.min(this.chatScroll, maxScroll);
			const end = all.length - scroll;
			body.push(...all.slice(Math.max(0, end - viewHeight), end));
			if (scroll > 0) body.push(dim(`↓ ${scroll} newer lines · G to follow`));
		}
		return [truncateToWidth(header, width), "", ...body];
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

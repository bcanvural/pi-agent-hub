// The hub overlay: a roster of background agents on the left, the selected
// child's conversation on the right, live — and a composer to talk back.
// Watching is free; every control goes through the owning extension's RPC,
// with that extension's own file inbox as the only fallback, and the label on
// each send says what actually happened to it (delivered, queued, parked).
import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/** What the roster shows. Session is the default — the agents THIS
 * conversation launched; f widens to the project, then the whole machine,
 * the hub's superpower the stock inspector lacks. */
type Scope = "project" | "session" | "machine";
const SCOPE_ORDER: Scope[] = ["session", "project", "machine"];
import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { findAck, readCapability, runnerReachable, steerInboxClosed, writeControlRequest, writeSteerRequestFile } from "./control-files.ts";
import { readOutputTail, sanitizeLine, type OutputTail } from "./output-tail.ts";
import { formatCost, formatTokens, UsageMeter } from "./usage.ts";
import { asyncRunsRoot, isStale, lastBeat, MAX_ROWS, rowKey, scanRuns, type RunRow, type ScanCache } from "./runs.ts";
import { readSupervisorWait, supervisorChannels, waitExpired, type SupervisorChannel, type SupervisorWait } from "./supervisor-channel.ts";
import { SubagentsRpc, type FleetSnapshot, type RpcEvents } from "./rpc.ts";
import { DEFAULT_SIZE } from "./settings.ts";
import { bottomOffsetOfRecord, buildChatWindow, recordPlainText, SessionTail } from "./session-view.ts";

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
	scroll: number;
	liveStamp: string;
	lines: string[];
	linesKnown: number;
	atOldest: boolean;
}

interface Notice {
	text: string;
	tone: "info" | "success" | "error";
	at: number;
	/** The run this notice describes; shown only while that run is selected.
	 * A notice about run A displayed under run B was a false statement in the
	 * one row whose purpose is delivery honesty. */
	runKey?: string;
}

interface AckWatch {
	runKey: string;
	agent: string;
	runDir: string;
	index: number;
	requestId: string;
	sentAt: number;
}

/** omp-style compact duration: `2m54s`, `1h12m`, `45s`. */
function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m${seconds % 60 ? `${seconds % 60}s` : ""}`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h${minutes % 60 ? `${minutes % 60}m` : ""}`;
}

function shortModel(model: string | undefined): string | undefined {
	if (!model) return undefined;
	const short = model.split("/").pop();
	return short || model;
}

function formatAge(from: number | undefined, now: number): string {
	if (!from) return "";
	const seconds = Math.max(0, Math.round((now - from) / 1000));
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
	if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
	return `${Math.round(seconds / 86400)}d`;
}

const EDIT_OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const EDIT_CSI = /\x1b\[[0-9;:<=>?]*[ -\/]*[@-~]/g;
const EDIT_SS3 = /\x1bO./g;
/** DCS, SOS, PM and APC: `ESC P|X|^|_ … ST`. Their payloads are terminal
 * responses (kitty graphics acks, DECRQSS), never typed text — stripping just
 * the introducer left `Gi=1;OK` in a message. */
const EDIT_DCS_LIKE = /\x1b[PX^_][^\x1b]*\x1b\\/g;
/** The same strings in their single-byte C1 forms, plus C1 CSI and OSC. The
 * generic control strip removes the C1 byte itself but would leave the
 * payload behind as text. */
const EDIT_C1_STRING = /[\u0090\u0098\u009e\u009f\u009d][^\u009c\u0007\u001b]*(?:\u009c|\u0007|\x1b\\)/g;
const EDIT_C1_CSI = /\u009b[0-9;:<=>?]*[ -\/]*[@-~]/g;
const EDIT_OTHER = /\x1b./g;

/** Longest partial escape sequence held between reads. Split paste markers
 * and split arrows fit in a few bytes; anything growing past this is an
 * unterminated string sequence swallowing keystrokes — an OSC introducer at
 * a paste boundary froze the composer while the carry ate 20,000 characters.
 * Sequence payloads are never message text, so the overflow is dropped. */
const EDIT_CARRY_MAX = 16;
/** Bytes the discard state may consume before giving up. A pasted truncated
 * capture has no terminator; swallowing keystrokes silently forever is the
 * freeze this machinery exists to prevent, so past the budget the discard
 * clears and says so. Sized for real string payloads (OSC-8 URLs, DECRQSS)
 * while keeping the worst silent swallow bounded and announced. */
const EDIT_DISCARD_MAX = 4096;

/** Keystrokes and pastes, reduced to what a single-line composer accepts.
 *
 * Every complete escape sequence is removed WHOLE — arrows, function keys,
 * mouse reports, bracketed-paste markers — because stripping only the ESC
 * byte inserted the sequence's tail as literal text: one Up-arrow put `[A`
 * into a message that was then steered into a live child. Newlines become
 * spaces and remaining control bytes are dropped; the buffer must never hold
 * a byte that could break a rendered row. */
function composerText(data: string): string {
	return data
		.replace(EDIT_OSC, "")
		.replace(EDIT_DCS_LIKE, "")
		.replace(EDIT_C1_STRING, "")
		.replace(EDIT_C1_CSI, "")
		.replace(EDIT_CSI, "")
		.replace(EDIT_SS3, "")
		.replace(EDIT_OTHER, "")
		.replace(/\r\n|\r|\n/g, " ")
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
}

/** Whether a datum tail beginning with ESC is an escape sequence still being
 * delivered — terminals split large pastes and even the paste markers across
 * reads, and consuming half a marker leaves the other half as visible junk.
 * Held-back bytes are prepended to the next datum instead. */
function incompleteEscape(tail: string): boolean {
	if (tail === "\x1b") return true;
	const kind = tail[1];
	if (kind === "[") return !/[@-~]/.test(tail.slice(2));
	if (kind === "]" || kind === "P" || kind === "X" || kind === "^" || kind === "_") {
		return !(tail.includes("\x07") || tail.includes("\x1b\\"));
	}
	if (kind === "O") return tail.length < 3;
	return false;
}

/** Append text to a buffer without ever ending on half a surrogate pair — a
 * blind UTF-16 slice at the cap left a lone surrogate that rendered one
 * column wider than every width check could see. */
function capText(text: string, max: number): string {
	let capped = text.length > max ? text.slice(0, max) : text;
	const last = capped.charCodeAt(capped.length - 1);
	if (last >= 0xd800 && last <= 0xdbff) capped = capped.slice(0, -1);
	// A cap landing after a zero-width joiner leaves it dangling, waiting to
	// fuse with whatever the receiving side prints next.
	if (capped.charCodeAt(capped.length - 1) === 0x200d) capped = capped.slice(0, -1);
	return capped;
}

/** Panel sizes `z` cycles through; /hub accepts any 40-100. */
export const SIZE_PRESETS = [50, 60, 80, 100];

/** The one place the size→overlay mapping lives: index.ts builds (and on
 * resize mutates in place) the overlay options from this, and render()
 * derives its height budget from the same margin. The overlay's maxHeight
 * stays "100%" so whatever render() emits is what pi shows — the old
 * hand-synced option/budget pair clipped the composer twice. Full size
 * drops the floating margin: 100% means the screen. */
export function overlayGeometry(sizePct: number): { width: `${number}%`; margin: number } {
	return { width: `${sizePct}%`, margin: sizePct >= 100 ? 0 : 1 };
}

export class AgentHubComponent {
	private rows: RunRow[] = [];
	private scope: Scope = "session";
	private readonly projectRoot: string;
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
	/** Latest notice per run (plus one global slot). A single shared slot meant
	 * a background run's ack either overwrote the visible notice (before the
	 * runKey gate) or blanked the row by evicting it (after). */
	private readonly notices = new Map<string, Notice>();
	private ackWatch: AckWatch | undefined;
	/** One control action in flight at a time; Enter with nothing visibly
	 * happening invited re-sends, and each re-send steered the child again. */
	private actionBusy = false;
	private editCarry = "";
	/** Set when a held sequence overflowed the carry bound: the rest of that
	 * sequence is still arriving, and dropping the carry alone let the
	 * remainder land as literal text — half a pasted URL in the message.
	 * Until the sequence's terminator passes, incoming bytes belong to it.
	 * `pendingEsc` remembers a datum that ended on the first byte of a split
	 * ST — without it, a terminator straddling a read boundary was never seen
	 * and the discard became the freeze it was built to prevent. `spent` is
	 * the byte budget: a truncated capture has no terminator at all, and an
	 * unbounded discard swallows keystrokes silently forever. */
	private editDiscard: { kind: "st" | "csi"; pendingEsc: boolean; spent: number } | undefined;
	private liveOutput: OutputTail | undefined;
	private liveOutputFile: string | undefined;
	/** One meter per session file. Bounded and pruned; completed runs cost one
	 * stat per occasional check after they converge. */
	private readonly meters = new Map<string, UsageMeter>();
	private lastRotated: string | undefined;

	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly done: (result: undefined) => void;

	private sizePct: number;
	private readonly onSizeChange?: (size: number) => void;

	constructor(
		tui: TUI,
		theme: Theme,
		events: RpcEvents,
		done: (result: undefined) => void,
		projectRoot?: string,
		sizePct?: number,
		onSizeChange?: (size: number) => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.done = done;
		this.sizePct = sizePct ?? DEFAULT_SIZE;
		this.onSizeChange = onSizeChange;
		// pi's session cwd, not the launch dir: `pi --resume` adopts the
		// session's directory while process.cwd() stays where pi was started,
		// and runs record the session cwd — comparing against the wrong one
		// made project scope silently empty after a cross-directory resume.
		this.projectRoot = path.resolve(projectRoot ?? process.cwd());
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

	private inScope(row: RunRow): boolean {
		if (this.scope === "machine") return true;
		if (this.scope === "project") return row.cwd !== undefined && path.resolve(row.cwd) === this.projectRoot;
		// Session scope: ownership by session identity. Unknown identity (no
		// bridge yet) matches nothing — the strip names the scope, so an empty
		// roster reads as "none here", not as a broken hub.
		return this.rpc.sessionId !== undefined && row.sessionId === this.rpc.sessionId;
	}

	/** Supervisor waits, keyed by CHANNEL directory rather than by row. A
	 * revival row shares its original's session file and therefore its child's
	 * channel, and keying by row counted one parked child twice — the same
	 * double count the cost meters already dedupe against (`scopeMeters`). */
	private readonly waits = new Map<string, SupervisorWait>();
	private readonly waitDirs = new Map<string, string>();

	/** A channel's identity as one unambiguous string. JSON-encoded because the
	 * tuple must not be re-parseable into a different tuple: joining on a
	 * separator only moved the collision from "-" onto that separator, and two
	 * children sharing a key meant one child's verdict was cached for both. */
	private static channelKey(channel: SupervisorChannel): string {
		return JSON.stringify([channel.dir, channel.childRunId, channel.agent, channel.childIndex]);
	}

	/** Probed for every RUNNING row, stale or not. Gating this on freshness was
	 * exactly backwards: a parked child stops emitting activity BECAUSE it is
	 * blocked, so the rows that most need the probe are the ones a heartbeat
	 * test rejects. Cost per tick: one readdir plus a read per pending request
	 * per distinct candidate channel, memoized across rows. */
	private refreshWaits(rows: RunRow[], now: number): void {
		this.waits.clear();
		this.waitDirs.clear();
		// Memoized by channel identity, not by row: twins share a probe, and a
		// candidate already found empty is not re-read for the next row.
		const probed = new Map<string, SupervisorWait | undefined>();
		for (const row of rows) {
			if (row.state !== "running") continue;
			// The run's own channel first, the inherited child's as a fallback:
			// a revived run launches under its own id and keeps the original's
			// session file, so the two disagree. Ownership is decided by which
			// candidate ANSWERS — directory existence cannot decide it, because
			// upstream collects empty channels after 60s and the revival's own
			// directory is empty until it asks something.
			const candidates = supervisorChannels(row.runId, row.stepIndex, row.sessionFile, row.agentName);
			// An unexpired ask outranks an expired one from an earlier candidate:
			// first-yield-wins let a timed-out leftover on the revival's own
			// channel stop the probe before the inherited channel holding the
			// conversation's LIVE question was ever read — a parked child with
			// no surface showing it. Candidate order still breaks ties.
			let chosenKey: string | undefined;
			let chosenWait: SupervisorWait | undefined;
			for (const candidate of candidates) {
				const key = AgentHubComponent.channelKey(candidate);
				if (!probed.has(key)) probed.set(key, readSupervisorWait(candidate, now));
				const wait = probed.get(key);
				if (wait === undefined) continue;
				if (chosenWait === undefined || (waitExpired(chosenWait, now) && !waitExpired(wait, now))) {
					chosenKey = key;
					chosenWait = wait;
				}
				if (!waitExpired(chosenWait, now)) break;
			}
			// Mapped ONLY when something was found. A row with no wait anywhere
			// used to key itself by its first candidate — a phantom naming
			// nothing — and every consumer of the map then had to know that;
			// the strip did not, and merged distinct children through it.
			if (chosenKey !== undefined && chosenWait !== undefined) {
				this.waits.set(chosenKey, chosenWait);
				this.waitDirs.set(rowKey(row), chosenKey);
			}
		}
	}

	/** What this child is parked on, if anything. */
	private waitFor(row: RunRow): SupervisorWait | undefined {
		const dir = this.waitDirs.get(rowKey(row));
		return dir !== undefined ? this.waits.get(dir) : undefined;
	}

	/** What can honestly be said about a running row. Silence is not death when
	 * the child has declared why it is silent: a park carries its own clock
	 * (600s, written into the request), which is the instrument here — the
	 * 120s heartbeat rule only means anything for a child with no declared
	 * reason to be quiet. Past the ask's deadline nothing is knowable from
	 * silence alone, because the heartbeat froze *because of* the park: that
	 * says unknown, not dead. */
	private liveness(row: RunRow, now: number): "live" | "parked" | "unknown" | "stale" | "ended" {
		// Its own value, not a borrowed "live". Returning "live" for a finished
		// row made every caller responsible for re-checking `state` first, and
		// the one that forgot — the strip — headlined "⟳ 7 running" one column
		// away from six ✓/✗ glyphs.
		if (row.state !== "running") return "ended";
		const wait = this.waitFor(row);
		// A heartbeat that moved after the ask expired proves the child gave up
		// waiting and went back to work.
		if (wait) return !waitExpired(wait, now) ? "parked" : isStale(row, now) ? "unknown" : "live";
		// Upstream's own flag, for the runs whose channel this process cannot
		// resolve. It carries no deadline, so a frozen heartbeat under it is the
		// same unknown.
		if (row.needsAttention) return isStale(row, now) ? "unknown" : "parked";
		return isStale(row, now) ? "stale" : "live";
	}

	/** Possibly alive: everything but a finished run and one whose record cannot
	 * be trusted. Steering one of these is safe (it queues); reviving one is not. */
	private maybeLive(row: RunRow, now: number): boolean {
		const liveness = this.liveness(row, now);
		return liveness !== "stale" && liveness !== "ended";
	}

	/** How long this row has been quiet, or that nothing was ever recorded. An
	 * absent heartbeat is not a heartbeat at time zero: printing the age of the
	 * epoch ("no answer for 496339h55m") is precisely the invented measurement
	 * the unknown verdict exists to refuse. */
	private quietLabel(row: RunRow, now: number): string {
		const beat = lastBeat(row, now);
		return beat > 0 ? `no answer for ${formatDuration(now - beat)}` : "no answer · no heartbeat recorded";
	}

	/** Rows merged away because another record of the same conversation speaks
	 * for them, keyed by the survivor: rowKey -> total records. Rebuilt every
	 * refresh. */
	private readonly recordCounts = new Map<string, number>();

	private refreshRuns(): void {
		if (this.disposed) return;
		const now = Date.now();
		const scoped = scanRuns(asyncRunsRoot(), this.scanCache).filter(row => this.inScope(row));
		// One row per CONVERSATION. A revived run launches under its own id but
		// continues the original child's session file, so two rows tail one
		// file and render the identical chat — the same conversation shown
		// twice, which reads as a phantom second agent. The liveliest record
		// speaks for the group (a recorded "running" first, then the freshest
		// beat) and wears the group's record count; actions then target the
		// record that can still take them. Rows without a session file have
		// nothing to share and never merge.
		const groups = new Map<string, RunRow[]>();
		for (const row of scoped) {
			const key = row.sessionFile ?? `#${rowKey(row)}`;
			const list = groups.get(key);
			if (list) list.push(row);
			else groups.set(key, [row]);
		}
		// Waits are probed over the PRE-merge records. Probing survivors only
		// meant the verdict was computed before the information that could
		// correct it existed — the third time this changeset paid for that
		// layering (isStale in round 1, directory existence in round 4): a
		// parked original was never probed once a finished sibling record
		// outranked it, and the buried conversation showed ✓ with "s resumes"
		// offered against a provably parked child.
		this.refreshWaits(scoped, now);
		this.recordCounts.clear();
		const hiddenToSurvivor = new Map<string, string>();
		const merged: RunRow[] = [];
		for (const group of groups.values()) {
			let best = group[0]!;
			for (const candidate of group.slice(1)) {
				// ALIVE NOW outranks, judged with the channel in view — a parked
				// child's heartbeat is frozen, so an isStale test called it dead
				// and buried its unanswered question behind a finished sibling
				// record. Before that, a bare "recorded running" test let detach
				// residue outrank a fresh completion forever — the one word
				// invariant 6 already calls untrustworthy, trusted by the merge
				// added to serve it. Everything not alive competes on beat, so
				// the freshest final record speaks for a finished conversation.
				const alive = (row: RunRow): boolean => {
					const liveness = this.liveness(row, now);
					return liveness === "live" || liveness === "parked";
				};
				const bestLive = alive(best);
				const candidateLive = alive(candidate);
				if (candidateLive !== bestLive ? candidateLive : lastBeat(candidate, now) > lastBeat(best, now)) best = candidate;
			}
			if (group.length > 1) {
				this.recordCounts.set(rowKey(best), group.length);
				for (const row of group) if (row !== best) hiddenToSurvivor.set(rowKey(row), rowKey(best));
			}
			merged.push(best);
		}
		this.rows = merged.slice(0, MAX_ROWS);
		// A selection on a merged-away record follows its conversation to the
		// survivor instead of snapping to the top of the list. The KEY swaps,
		// nothing else: rows only merge because they share a session file, so
		// the survivor tails the same file and there is nothing to reset —
		// going through select() yanked a reader scrolled up in history back
		// to the tail and re-read the whole session file for no new content.
		if (this.selectedKey !== undefined && hiddenToSurvivor.has(this.selectedKey)) {
			this.selectedKey = hiddenToSurvivor.get(this.selectedKey);
		}
		// In-flight outcomes follow the conversation too: a notice or an ack
		// watch keyed to a merged-away record silently vanished — the result
		// of the user's own last action, lost at the moment it landed.
		for (const [key, notice] of [...this.notices]) {
			const survivor = hiddenToSurvivor.get(key);
			if (survivor === undefined) continue;
			this.notices.delete(key);
			const standing = this.notices.get(survivor);
			if (standing === undefined || standing.at < notice.at) this.notices.set(survivor, notice);
		}
		if (this.ackWatch !== undefined) {
			const survivor = hiddenToSurvivor.get(this.ackWatch.runKey);
			// The display target only: runDir/index still name the hidden run's
			// control files, which is where the ack actually lands.
			if (survivor !== undefined) this.ackWatch.runKey = survivor;
		}
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
		// A child parking on a supervisor reply changes nothing else about the
		// run — same state, same heartbeat — so the wait belongs in the
		// signature or the row would keep its old label until something else
		// moved. The time bucket keeps relative ages honest: a parked child
		// writes NOTHING, so without it the signature froze and the panel
		// stopped repainting entirely — "12s active" still on screen three
		// minutes into the park. One repaint per five seconds is the cost.
		const signature = `${this.scope}|t:${Math.floor(now / 5000)}|${this.rows.map(row => `${rowKey(row)}|${row.state}|${row.detached}|${this.liveness(row, now)}|${this.waitFor(row)?.requestId}|${this.recordCounts.get(rowKey(row)) ?? 1}|${row.lastUpdate}|${row.currentTool}`).join(";")}|rpc:${this.rpcInfo.available}:${this.rpcInfo.totalActive}`;
		if (signature !== this.lastSignature) {
			this.lastSignature = signature;
			this.tui.requestRender();
		}
	}

	private async refreshRpc(): Promise<void> {
		// Captured before any await: the bridge's ready broadcast can land
		// during the fleet round trip, and reading afterwards made the
		// undefined→defined transition invisible — the default session view
		// then sat empty until the next scan tick.
		const hadIdentity = this.rpc.sessionId !== undefined;
		const fleet = await this.rpc.fleet();
		if (this.disposed) return;
		if (fleet.available) await this.rpc.identify();
		if (this.disposed) return;
		const tokenSum = (entries: FleetSnapshot["entries"]): number =>
			entries.reduce((sum, entry) => (typeof entry.tokens?.total === "number" && Number.isFinite(entry.tokens.total) && entry.tokens.total > 0 ? sum + entry.tokens.total : sum), 0);
		const changed =
			fleet.available !== this.rpcInfo.available ||
			fleet.totalActive !== this.rpcInfo.totalActive ||
			tokenSum(fleet.entries) !== tokenSum(this.rpcInfo.entries);
		this.rpcInfo = fleet;
		// Session identity arriving is what makes the session scope filterable —
		// re-filter immediately rather than leaving the default view empty
		// until the next scan tick.
		if (!hadIdentity && this.rpc.sessionId !== undefined) {
			this.lastSignature = "";
			this.refreshRuns();
		}
		if (changed) this.tui.requestRender();
	}

	private pollTail(): void {
		if (this.disposed) return;
		if (this.tail?.poll()) {
			this.chatMemo = undefined;
			this.tui.requestRender();
		}
		this.pollLiveOutput();
		this.advanceUsage();
		this.pollAck();
		const now = Date.now();
		let pruned = false;
		for (const [key, notice] of this.notices) {
			if (now - notice.at > this.noticeTtl(notice)) {
				this.notices.delete(key);
				pruned = true;
			}
		}
		if (pruned) this.tui.requestRender();
	}

	/** At most three meters advance per tick (selected, first unconverged,
	 * one rotating): the cold fill of a roster of multi-megabyte sessions
	 * spreads across ticks instead of stalling the event loop, and a fully
	 * converged roster costs two stats a tick. */
	private advanceUsage(): void {
		const candidates: string[] = [];
		const selected = this.selectedRow();
		if (selected?.sessionFile) candidates.push(selected.sessionFile);
		for (const row of this.rows) {
			if (row.sessionFile && !candidates.includes(row.sessionFile)) candidates.push(row.sessionFile);
		}
		if (this.meters.size > 300) {
			const keep = new Set(candidates);
			for (const key of this.meters.keys()) {
				if (!keep.has(key)) this.meters.delete(key);
				if (this.meters.size <= 300) break;
			}
		}
		// Three looks per tick, all cheap when nothing changed: the selected
		// meter (its run may be growing), the first meter that has not yet
		// converged (the cold fill), and one ROTATING candidate regardless of
		// state — without the rotation, a converged meter on a run that keeps
		// running froze at whatever it read first and presented that number as
		// settled: three of four running agents showing dead costs in the
		// hub's own headline scenario.
		let advanced = false;
		const meterFor = (file: string): UsageMeter => {
			let meter = this.meters.get(file);
			if (!meter) {
				meter = new UsageMeter(file);
				this.meters.set(file, meter);
			}
			return meter;
		};
		if (candidates.length > 0) {
			if (meterFor(candidates[0]!).advance()) advanced = true;
			const cold = candidates.find((file, index) => index > 0 && !meterFor(file).done);
			if (cold && meterFor(cold).advance()) advanced = true;
			// The rotating cursor is an IDENTITY, not a position: an index into
			// a list whose length flaps can cycle a subset of positions and
			// starve a row forever — present half the ticks, advanced on none,
			// its frozen cost shown as settled. "Next after the last file
			// advanced" reaches every present candidate regardless of churn.
			const start = this.lastRotated ? candidates.indexOf(this.lastRotated) : -1;
			for (let step = 1; step <= candidates.length; step++) {
				const file = candidates[(start + step) % candidates.length]!;
				if (file === candidates[0] || file === cold) continue;
				this.lastRotated = file;
				if (meterFor(file).advance()) advanced = true;
				break;
			}
		}
		if (advanced) this.tui.requestRender();
	}

	private usageFor(file: string | undefined): UsageMeter | undefined {
		return file ? this.meters.get(file) : undefined;
	}

	/** The output log streams while the session file waits for the tool to
	 * finish — the one live signal a long tool call gives off. */
	private pollLiveOutput(): void {
		const row = this.selectedRow();
		const now = Date.now();
		const live = row !== undefined && this.maybeLive(row, now) && this.follow;
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
		const { runKey, agent, runDir, index, requestId, sentAt } = this.ackWatch;
		const ack = findAck(runDir, index, requestId);
		if (ack) {
			// `queued` is a waypoint, not an outcome — keep watching for the
			// delivered/failed transition instead of declaring victory early.
			if (ack.state === "queued") {
				const existing = this.notices.get(runKey);
				if (!existing || !existing.text.includes("queued")) {
					this.setNotice(`${agent}: queued — delivers between turns`, "info", runKey);
				}
			} else {
				this.ackWatch = undefined;
				if (ack.state === "delivered") this.setNotice(`${agent}: delivered`, "success", runKey);
				else this.setNotice(`${agent}: steer failed — ${ack.message ?? "no reason given"}`, "error", runKey);
				return;
			}
		}
		if (Date.now() - sentAt > ACK_WAIT_MS) {
			this.ackWatch = undefined;
			this.setNotice(`${agent}: no acknowledgment — it stays queued in the run's inbox`, "info", runKey);
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

	private setNotice(text: string, tone: Notice["tone"], runKey?: string): void {
		// Foreign text reaches this — bridge reply wording, agent names — and a
		// control byte in a notice is a control byte in a rendered row.
		this.notices.set(runKey ?? "", { text: sanitizeLine(text), tone, at: Date.now(), ...(runKey !== undefined ? { runKey } : {}) });
		this.tui.requestRender();
	}

	private noticeTtl(notice: Notice): number {
		return notice.tone === "error" ? 10_000 : 6000;
	}

	/** The notice the action row shows: the selected run's, else the global
	 * one. Fresh entries only; expiry is pruned on the poll tick. */
	private visibleNotice(now: number): Notice | undefined {
		for (const key of [this.selectedKey ?? "", ""]) {
			const notice = this.notices.get(key);
			if (notice && now - notice.at <= this.noticeTtl(notice)) return notice;
		}
		return undefined;
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

	/** Which channel a message to this run takes. A live STEP can be steered;
	 * anything else — finished, failed, or recorded running by a parent that
	 * died — is a resume, which revives the child. Judging this by the run's
	 * state offered to *revive* children that were still running under an
	 * ended run record, which is the one thing upstream tells callers never to
	 * do while a detached child may still be live. */
	private channelFor(row: RunRow, now: number): "steer" | "resume" {
		return this.maybeLive(row, now) ? "steer" : "resume";
	}

	/** Synchronous acceptance check: true means the message is on its way and
	 * the composer may clear. Refusing AFTER the composer cleared destroyed
	 * whatever the user had typed. */
	private trySend(row: RunRow, text: string): boolean {
		if (this.actionBusy) {
			this.setNotice("still sending the previous action — your text is kept", "info", rowKey(row));
			return false;
		}
		this.actionBusy = true;
		void (async () => {
			try {
				await this.sendMessageInner(row, text);
			} finally {
				this.actionBusy = false;
			}
		})();
		return true;
	}

	private async sendMessageInner(row: RunRow, text: string): Promise<void> {
		const key = rowKey(row);
		this.setNotice(`sending to ${row.agent}…`, "info", key);
		const target = { id: row.runId, ...(row.stepCount > 1 ? { index: row.stepIndex } : {}) };
		const owns = this.ownsRun(row);
		if (this.channelFor(row, Date.now()) === "steer") {
			const live = runnerReachable(readCapability(row.dir, row.stepIndex)) && !steerInboxClosed(row.dir);
			// Read once, above the ownership split: a parked child cannot take a
			// message on EITHER channel, and fixing only the bridge path left the
			// foreign-session path promising delivery one keypress after the same
			// row said to answer in the conversation.
			const parked = this.liveness(row, Date.now()) === "parked";
			if (owns === false) {
				// The bridge will refuse a foreign run; its runner's file inbox
				// is the sanctioned cross-process channel when one is alive.
				if (live) {
					try {
						const requestId = writeSteerRequestFile(row.dir, text, row.stepIndex);
						this.ackWatch = { runKey: key, agent: row.agent, runDir: row.dir, index: row.stepIndex, requestId, sentAt: Date.now() };
						this.setNotice(parked
							? "in the runner's inbox — the child reads it once you answer the supervisor"
							: "dropped in the runner's inbox — waiting for the ack…", "info", key);
					} catch (error) {
						this.setNotice(error instanceof Error ? error.message : String(error), "error", key);
					}
				} else {
					this.setNotice("view-only: this run belongs to another pi session and has no live runner", "error", key);
				}
				return;
			}
			const outcome = await this.rpc.steer(target, text);
			if (this.disposed) return;
			if (outcome.ok) {
				if (parked) {
					// The bridge accepted it, and the child cannot read it: it is
					// blocked in a poll for a supervisor reply, not between turns.
					// Claiming between-turn delivery here contradicted the same
					// row's own action line one keypress earlier.
					this.setNotice("accepted · the child is parked on a supervisor reply and reads this only once you answer", "info", key);
				} else if (live) {
					// No ack watch on this path: the owning extension consumes ack
					// files itself (read-and-delete), so a watcher here races the
					// owner and loses — delivery shows up as the child reacting.
					this.setNotice("steering — the runner delivers it between turns", "success", key);
				} else {
					// Honest label for the attached case: the inbox holds it, and
					// nothing reads that inbox until the run is resumed. Worded
					// away from "parked", which now means a specific other thing
					// one row above — a child blocked on a supervisor reply.
					this.setNotice("accepted · queued in the run's inbox — delivers when this run is resumed", "info", key);
				}
			} else if (outcome.unreachable && live) {
				// No bridge in this pi, but a live detached runner owns the run:
				// its file inbox exists exactly for this.
				try {
					const requestId = writeSteerRequestFile(row.dir, text, row.stepIndex);
					this.ackWatch = { runKey: key, agent: row.agent, runDir: row.dir, index: row.stepIndex, requestId, sentAt: Date.now() };
					this.setNotice("dropped in the runner's inbox — waiting for the ack…", "info", key);
				} catch (error) {
					this.setNotice(error instanceof Error ? error.message : String(error), "error", key);
				}
			} else if (outcome.unreachable) {
				this.setNotice("no live channel: the subagents extension is not answering and no runner owns this run", "error", key);
			} else {
				this.setNotice(outcome.text || "steer rejected", "error", key);
			}
			return;
		}
		if (owns === false) {
			this.setNotice("view-only: only the pi session that launched this run can resume it", "error", key);
			return;
		}
		const outcome = await this.rpc.resume(target, text);
		if (this.disposed) return;
		if (outcome.ok) {
			this.setNotice(`resuming — ${row.agent} answers here as it works`, "success", key);
			this.refreshRuns();
		} else if (outcome.unreachable) {
			this.setNotice("resume needs the subagents extension in this session", "error", key);
		} else {
			this.setNotice(outcome.text || "resume rejected", "error", key);
		}
	}

	private async interruptRun(row: RunRow): Promise<void> {
		const key = rowKey(row);
		if (this.channelFor(row, Date.now()) !== "steer") {
			this.setNotice("nothing to interrupt — this run is not live", "error", key);
			return;
		}
		if (this.actionBusy) {
			this.setNotice("still sending the previous action…", "info", key);
			return;
		}
		this.actionBusy = true;
		this.setNotice(`interrupting ${sanitizeLine(row.agent)}…`, "info", key);
		try {
			await this.interruptInner(row, key);
		} finally {
			this.actionBusy = false;
		}
	}

	private async interruptInner(row: RunRow, key: string): Promise<void> {
		if (this.ownsRun(row) === false) {
			this.fileControlRequest(row, "interrupt");
			return;
		}
		const outcome = await this.rpc.interrupt({ id: row.runId, ...(row.stepCount > 1 ? { index: row.stepIndex } : {}) });
		if (this.disposed) return;
		if (outcome.ok) this.setNotice(outcome.text || "interrupt requested", "success", key);
		else if (outcome.unreachable) this.fileControlRequest(row, "interrupt");
		else this.setNotice(outcome.text || "interrupt rejected", "error", key);
	}

	/** The file-inbox fallback for interrupt/stop, with the same honesty gates
	 * as steering: a dead runner or a closed inbox means the file would sit
	 * unread forever, so refuse with the reason instead of claiming delivery. */
	private fileControlRequest(row: RunRow, kind: "interrupt" | "stop"): void {
		const key = rowKey(row);
		if (!runnerReachable(readCapability(row.dir, row.stepIndex))) {
			this.setNotice(`no channel to ${kind} this run — no live runner owns it`, "error", key);
			return;
		}
		if (steerInboxClosed(row.dir)) {
			this.setNotice(`the run's inbox is closed — the runner is settling and would not read the ${kind}`, "error", key);
			return;
		}
		try {
			writeControlRequest(row.dir, kind, "requested from pi-agent-hub");
			this.setNotice(`${kind} dropped in the runner's inbox`, "info", key);
		} catch (error) {
			this.setNotice(error instanceof Error ? error.message : String(error), "error", key);
		}
	}

	private async stopRun(row: RunRow): Promise<void> {
		const key = rowKey(row);
		if (this.actionBusy) {
			this.setNotice("still sending the previous action…", "info", key);
			return;
		}
		this.actionBusy = true;
		this.setNotice(`stopping ${sanitizeLine(row.agent)}…`, "info", key);
		try {
			await this.stopInner(row, key);
		} finally {
			this.actionBusy = false;
		}
	}

	private async stopInner(row: RunRow, key: string): Promise<void> {
		if (this.ownsRun(row) === false) {
			this.fileControlRequest(row, "stop");
			return;
		}
		const outcome = await this.rpc.stop({ id: row.runId });
		if (this.disposed) return;
		if (outcome.ok) {
			this.setNotice(outcome.text || "stop requested", "success", key);
			this.refreshRuns();
		} else if (outcome.unreachable) this.fileControlRequest(row, "stop");
		else this.setNotice(outcome.text || "stop rejected", "error", key);
	}

	/** Open the child's cwd / copy its session path. User-invoked one-shots;
	 * failure is a notice, never a throw. */
	private openCwd(row: RunRow): void {
		if (!row.cwd) return this.setNotice("this run recorded no working directory", "error");
		const opener = process.platform === "darwin" ? "open" : "xdg-open";
		try {
			const proc = child_process.spawn(opener, [row.cwd], { detached: true, stdio: "ignore" });
			// Spawn failure arrives as an async 'error' event; without a listener
			// it becomes an uncaughtException, and pi answers that with
			// process.exit(1) — one keypress on a machine without the opener
			// destroyed the whole session.
			proc.on("error", error => {
				if (!this.disposed) this.setNotice(`could not open: ${(error as NodeJS.ErrnoException).code === "ENOENT" ? `${opener} not available` : error.message}`, "error");
			});
			proc.unref();
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
			let failed = false;
			proc.on("error", () => {
				failed = true;
				if (!this.disposed) this.setNotice(`copy failed (${tool} not available)`, "error");
			});
			// Success is claimed when the path has been handed over, not before:
			// pbcopy exits (close fires), but xclip forks to own the selection
			// and never closes — gating on close left Linux permanently silent.
			proc.stdin.on("error", () => {});
			proc.stdin.end(row.sessionFile, () => {
				setTimeout(() => {
					if (!this.disposed && !failed) this.setNotice("session path copied", "success");
				}, 60);
			});
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
		// A cold jump renders every record between the tail and the target —
		// measured 407ms worst-case on a 50MB session (316 retained records),
		// once, warm 0ms after. Accepted: it is user-invoked, bounded by
		// MAX_RECORDS, and the alternative is a scroll position that lies.
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
		// The roster owns the unshifted keys: j/k (and the arrows) move between
		// agents, which is what the panel is for and what the hand reaches for
		// first; shift means "act on the conversation instead" — J/K scroll the
		// chat pane, alongside u/d, which keep their half-page motions.
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
		// Half-page vim motions on plain u/d: pi-tui's editor owns ctrl+u
		// ("delete to line start") and ctrl+d at a layer above overlays, so the
		// ctrl forms never arrive — kept below as aliases for terminals where
		// they do. Plain printables in nav mode are entirely ours.
		if (data === "u" || data === "\x15") return this.scrollChat(Math.max(1, Math.floor(this.lastPaneHeight / 2)));
		if (data === "d" || data === "\x04") return this.scrollChat(-Math.max(1, Math.floor(this.lastPaneHeight / 2)));
		if (data === "\x1b[5~") return this.scrollChat(this.lastPaneHeight);
		if (data === "\x1b[6~") return this.scrollChat(-this.lastPaneHeight);
		if (data === "g") {
			// Jump to the oldest retained record. The walk renders everything
			// between the tail and the top once (bounded by MAX_RECORDS, warm
			// afterwards — same cost class as a deep search jump), and render's
			// clamp then converts "as far as possible" into the exact offset.
			this.chatScroll = Number.MAX_SAFE_INTEGER;
			this.follow = false;
			this.chatMemo = undefined;
			this.tui.requestRender();
			return;
		}
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
		if (data === "f") {
			this.scope = SCOPE_ORDER[(SCOPE_ORDER.indexOf(this.scope) + 1) % SCOPE_ORDER.length]!;
			this.lastSignature = "";
			this.refreshRuns();
			return;
		}
		if (data === "z") {
			// Cycle the panel size; the owner (index.ts) mutates the overlay
			// options we were mounted with, and pi re-resolves them next frame.
			const next = SIZE_PRESETS.find(size => size > this.sizePct) ?? SIZE_PRESETS[0]!;
			this.sizePct = next;
			this.onSizeChange?.(next);
			this.tui.requestRender();
			return;
		}
		if (data === "r" || data === "R") {
			this.scanCache.clear();
			this.lastSignature = "";
			this.rpc.resetIdentify();
			this.refreshRuns();
			void this.refreshRpc();
			return;
		}
	}

	private handleEditingInput(data: string): void {
		const composing = this.mode === "compose";
		// Deliberate: a bare ESC cancels even though it could be the head of an
		// arrow split across reads — cancel is what a person pressing ESC means,
		// and the orphaned tail lands in nav mode where it matches no binding.
		// The same ambiguity makes a stranded `ESC [` carry eat exactly one
		// typed character (its final byte); one character, once, with no way to
		// tell an arrow's final from a keystroke at this layer.
		if (data === "\x1b" || data === "\x03") {
			this.mode = "nav";
			this.editCarry = "";
			this.editDiscard = undefined;
			this.tui.requestRender();
			return;
		}
		if (data === "\r" || data === "\n") {
			this.editCarry = "";
			this.editDiscard = undefined;
			if (composing) {
				const row = this.selectedRow();
				const text = this.composer.trim();
				if (!row || !text) {
					this.mode = "nav";
					this.composer = "";
				} else if (this.trySend(row, text)) {
					this.mode = "nav";
					this.composer = "";
				}
				// Refused: stay in compose with the text intact.
			} else {
				this.mode = "nav";
				this.runSearch(this.searchInput.trim());
			}
			this.tui.requestRender();
			return;
		}
		if (data === "\x7f" || data === "\x08") {
			this.editCarry = "";
			this.editDiscard = undefined;
			if (composing) this.composer = [...this.composer].slice(0, -1).join("");
			else this.searchInput = [...this.searchInput].slice(0, -1).join("");
			this.tui.requestRender();
			return;
		}
		if (data === "\x15") {
			this.editCarry = "";
			this.editDiscard = undefined;
			if (composing) this.composer = "";
			else this.searchInput = "";
			this.tui.requestRender();
			return;
		}
		let payload = data;
		// Finish discarding a sequence whose head already overflowed the carry:
		// everything up to its terminator is sequence payload, not typing.
		if (this.editDiscard) {
			const discard = this.editDiscard;
			let end = -1;
			if (discard.kind === "st") {
				if (discard.pendingEsc) {
					discard.pendingEsc = false;
					if (payload.startsWith("\\")) end = 1;
				}
				if (end === -1) {
					const bel = payload.indexOf("\x07");
					const st = payload.indexOf("\x1b\\");
					if (bel !== -1 && (st === -1 || bel < st)) end = bel + 1;
					else if (st !== -1) end = st + 2;
					else if (payload.endsWith("\x1b")) discard.pendingEsc = true;
				}
			} else {
				const final = /[@-~]/.exec(payload);
				if (final) end = final.index + 1;
			}
			if (end === -1) {
				discard.spent += payload.length;
				if (discard.spent > EDIT_DISCARD_MAX) {
					this.editDiscard = undefined;
					this.setNotice("an unterminated escape sequence in the input was ignored — check the message before sending", "info");
				}
				return;
			}
			payload = payload.slice(end);
			this.editDiscard = undefined;
			if (!payload) return;
		}
		let combined = this.editCarry + payload;
		this.editCarry = "";
		// Hold back an escape sequence still being delivered — the paste
		// markers themselves split across reads — rather than mangle its halves.
		// Bounded: a stranded string introducer (an OSC cut at a read boundary)
		// otherwise swallows every keystroke after it, silently and forever.
		// Past the bound, switch to discarding the rest of that sequence up to
		// its terminator — sequence payloads are never message text, and merely
		// dropping the carry let the remainder print as if it were.
		const lastEscape = combined.lastIndexOf("\x1b");
		if (lastEscape !== -1 && incompleteEscape(combined.slice(lastEscape))) {
			const held = combined.slice(lastEscape);
			if (held.length > EDIT_CARRY_MAX) {
				this.editDiscard = { kind: held[1] === "[" || held[1] === "O" ? "csi" : "st", pendingEsc: held.endsWith("\x1b") && held.length > 1, spent: held.length };
			} else {
				this.editCarry = held;
			}
			combined = combined.slice(0, lastEscape);
		}
		const text = composerText(combined);
		if (!text) return;
		if (composing) {
			this.composer = capText(this.composer + text, COMPOSER_MAX_CHARS);
			if (this.composer.length >= COMPOSER_MAX_CHARS - 1) this.setNotice("message is at the 8000-character cap", "info");
		} else {
			this.searchInput = capText(this.searchInput + text, 200);
		}
		this.tui.requestRender();
	}

	private lastChatHeight = 10;
	/** Pane height before the indicator/live-output reservations — the stable
	 * unit for page and half-page motions. Using the post-reservation view
	 * height made ctrl+u then ctrl+d drift by a line, because scrolling up
	 * reserves the indicator row and shrinks the next motion's half. */
	private lastPaneHeight = 10;
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
		// The outer frame takes the focused-overlay color — the same key pi's
		// own tree selector frames itself with — so the panel separates from
		// whatever busy screen it floats over. Interior furniture (the pane
		// separator) stays muted: one focused panel, not more lines everywhere.
		const border = (text: string): string => this.theme.fg("borderAccent", text);
		const terminalRows = (this.tui as unknown as { terminal?: { rows?: number } }).terminal?.rows ?? 40;
		// The size preset owns the height: the overlay clips only at the
		// terminal (maxHeight "100%"), so emission here IS the panel. The
		// 16-row floor keeps small terminals usable when the preset asks for
		// less; the margin cap keeps the floor below what pi will show — a
		// floor above the clip once made a 16-row terminal render a composer
		// nobody could see: type blind, send blind.
		const margin = overlayGeometry(this.sizePct).margin;
		const availRows = Math.max(1, terminalRows - margin * 2);
		const height = Math.min(availRows, Math.max(16, Math.floor((terminalRows * this.sizePct) / 100)));
		// The panel draws its own frame — the overlay paints no border of its
		// own, and unframed rows read as text floating over the app.
		const innerWidth = Math.max(40, width - 4);
		// The chrome sheds decoration before content as the panel shrinks:
		// the gaps go first, then the stats strip, then the hint bar — the
		// action row (the composer) and the body go last, because a composer
		// the overlay clips is typing blind, the exact failure the parity round
		// already paid for once. Total emitted lines always equal `height`.
		// Both rows around the stats strip are structure, not margin, and both
		// survive full size: the strip needs air on each side or it merges into
		// the furniture it sits between — into the titled border above, into the
		// roster below, where it reads as the list's first entry. The chat pane
		// spends a row on exactly this separation under its own header
		// (renderChat). They are still the first thing shed when the panel is
		// too short to afford them.
		const statsRow = height >= 9 ? 1 : 0;
		const stripGap = statsRow && height >= 12 ? 1 : 0;
		const hintsRow = height >= 5 ? 1 : 0;
		const bodyHeight = Math.max(0, height - 3 - hintsRow - statsRow - stripGap * 2);
		this.lastChatHeight = Math.max(1, bodyHeight - 2);
		const listWidth = Math.min(48, Math.max(26, Math.floor(innerWidth * 0.32)));
		const chatWidth = Math.max(20, innerWidth - listWidth - 3);

		const pad = (text: string, target: number): string => {
			const clipped = truncateToWidth(text, target);
			const deficit = target - visibleWidth(clipped);
			return deficit > 0 ? clipped + " ".repeat(deficit) : clipped;
		};

		const title = ` ${this.theme.fg("accent", this.theme.bold("Agent Hub"))} `;

		// The two counts describe different populations and must say so. The
		// run count is the scan of this machine's shared artifact root — every
		// pi session this user has run. The active count comes from the
		// subagents bridge, which reports only the session we are inside,
		// foreground delegations included.
		// A parked child counts as running — it is alive and it is this
		// session's work — but it is counted AGAIN under its own heading,
		// because a roster of five where one is parked is a different
		// situation from five that are working.
		//
		// Every count dedupes by child, not by row, and the identity is the
		// SESSION FILE — the one artifact a revival and its original actually
		// share. Never the chosen channel key, which depends on wait discovery:
		// keyed by channel, the headline flapped "2 running" ↔ "1 waiting" as
		// one child parked and unparked, and two distinct children whose dirs
		// recorded one runId merged while working and split once parked.
		const runningChildren = new Set<string>();
		const parkedChildren = new Set<string>();
		const unknownChildren = new Set<string>();
		for (const row of this.rows) {
			const liveness = this.liveness(row, now);
			const child = row.sessionFile ?? rowKey(row);
			if (liveness === "unknown") unknownChildren.add(child);
			if (liveness !== "live" && liveness !== "parked") continue;
			runningChildren.add(child);
			if (liveness === "parked") parkedChildren.add(child);
		}
		const running = runningChildren.size;
		const waiting = parkedChildren.size;
		const unknown = unknownChildren.size;
		// Foreign numbers deserve the same suspicion as foreign strings: a
		// string total concatenates instead of adding, Infinity renders as
		// "InfinityK tok".
		const sessionTokens = this.rpcInfo.entries.reduce((sum, entry) => {
			const total = entry.tokens?.total;
			return typeof total === "number" && Number.isFinite(total) && total > 0 ? sum + total : sum;
		}, 0);
		// Session scope has a third state: identity not known (bridge silent or
		// answering without a session). Claiming "0 runs in this session" there
		// asserted an evaluation that never ran — beside the bridge's own
		// active count, a visible self-contradiction.
		const sessionUnknown = this.scope === "session" && this.rpc.sessionId === undefined;
		const scopeLabel = this.scope === "machine" ? "on this machine" : this.scope === "project" ? "in this project" : "in this session";
		// Summed over unique meters: revival rows share their original's
		// session file, and summing per row would bill one conversation twice.
		// Completeness is judged only over rows that CAN be metered — a run
		// with no session file kept the ellipsis on forever.
		const scopeMeters = new Set<UsageMeter>();
		let scopeCostComplete = false;
		{
			let meterable = 0;
			let done = 0;
			for (const row of this.rows) {
				const meter = this.usageFor(row.sessionFile);
				if (row.sessionFile) meterable++;
				if (meter) {
					scopeMeters.add(meter);
					if (meter.done) done++;
				}
			}
			scopeCostComplete = meterable > 0 && done === meterable;
		}
		let scopeCost = 0;
		for (const meter of scopeMeters) scopeCost += meter.totals.cost;
		const statsParts = [
			sessionUnknown
				? dim("session not identified yet")
				: running > 0
					? this.theme.fg("warning", `⟳ ${running} running`)
					// "No agents running" is a claim of absence, and it must not
					// be made over rows the same frame calls unknown.
					: unknown > 0
						? dim("no agents confirmed running")
						: dim("No agents running"),
			...(!sessionUnknown && waiting > 0 ? [this.theme.fg("accent", `! ${waiting} waiting on you`)] : []),
			...(!sessionUnknown && unknown > 0 ? [dim(`? ${unknown} unknown`)] : []),
			sessionUnknown ? dim("r retries · f scope") : dim(`${this.rows.length} run${this.rows.length === 1 ? "" : "s"} ${scopeLabel} · f scope`),
			...(!sessionUnknown && scopeCost > 0 ? [dim(`${formatCost(scopeCost)}${scopeCostComplete ? "" : "…"}`)] : []),
			!this.rpcInfo.available
				? dim("subagents not answering")
				: this.rpcInfo.totalActive === undefined
					? this.theme.fg("success", "linked")
					: this.theme.fg("success", `${this.rpcInfo.totalActive} active in this session`),
			...(sessionTokens > 0 ? [dim(`${sessionTokens >= 1000 ? `${(sessionTokens / 1000).toFixed(1)}K` : sessionTokens} tok this session`)] : []),
		];
		const stats = statsParts.join(dim(" · "));

		const frameRow = (content: string, left: string, right: string): string => {
			const fill = Math.max(0, width - left.length - right.length - visibleWidth(content));
			return truncateToWidth(`${border(left)}${content}${border("─".repeat(fill))}${border(right)}`, width);
		};
		const framed = (content: string): string => truncateToWidth(`${border("│")} ${pad(content, width - 4)} ${border("│")}`, width);

		const lines: string[] = [frameRow(truncateToWidth(title, width - 4), "╭─", "╮")];
		if (stripGap) lines.push(framed(""));
		if (statsRow) lines.push(framed(truncateToWidth(stats, innerWidth)));
		if (stripGap) lines.push(framed(""));
		const listLines = this.renderList(listWidth, bodyHeight, now);
		const chatLines = this.renderChat(chatWidth, bodyHeight);
		const separator = this.theme.fg("borderMuted", "│");
		for (let index = 0; index < bodyHeight; index++) {
			const inner = `${pad(listLines[index] ?? "", listWidth)} ${separator} ${pad(chatLines[index] ?? "", chatWidth)}`;
			lines.push(framed(inner));
		}
		lines.push(framed(this.renderActionRow(innerWidth, now)));
		// Inside the frame, above the floor: the panel is self-contained.
		// Hints hanging under the border floated over the host conversation
		// and read as belonging to neither.
		if (hintsRow) lines.push(framed(dim(truncateToWidth(this.bottomHints(innerWidth), innerWidth))));
		lines.push(frameRow("", "╰─", "╯"));
		// Exact emission even below the ladder's floor (a terminal too small
		// for the fixed chrome): never hand the overlay more lines than the
		// height it will show.
		return lines.length > height ? lines.slice(0, Math.max(1, height)) : lines;
	}

	private bottomHints(maxWidth: number): string {
		if (this.mode === "compose") return "enter send · esc cancel";
		if (this.mode === "search") return "enter find · esc cancel";
		if (this.mode === "confirmStop") return "D confirm stop · any other key cancels";
		// Tiered to the frame, never truncated mid-key: narrow presets get a
		// shorter list, not half a binding.
		const tiers = [
			"j/k·↑/↓ select · J/K·u/d scroll · g/G top/tail · f scope · z size · x expand · s message · i interrupt · D stop · / find · q close",
			"j/k select · J/K scroll · f scope · z size · x expand · s message · D stop · / find · q close",
			"j/k select · J/K scroll · s message · z size · q close",
			"s message · q close",
		];
		return tiers.find(tier => tier.length <= maxWidth) ?? tiers[tiers.length - 1]!;
	}

	/** The row under the panes: the composer when typing, otherwise the latest
	 * action's outcome or what the composer would do. */
	private renderActionRow(width: number, now: number): string {
		const dim = (text: string): string => this.theme.fg("dim", text);
		const row = this.selectedRow();
		if (this.mode === "compose" || this.mode === "search") {
			const composing = this.mode === "compose";
			const channel = composing && row ? this.channelFor(row, now) : undefined;
			const label = composing ? `${channel} → ${sanitizeLine(row?.agent ?? "?")}` : "find";
			const buffer = composing ? this.composer : this.searchInput;
			const prompt = `${this.theme.fg("accent", label)} ${dim("›")} `;
			const room = Math.max(8, width - visibleWidth(prompt) - 2);
			// Built from whole code points, tail-first, measuring only what the
			// row can hold: the unit-blind loop both split surrogate pairs and
			// re-measured an 8000-char buffer per shaved character — tens of
			// milliseconds on every keystroke.
			let shown = buffer;
			if (visibleWidth(buffer) > room) {
				const characters = Array.from(buffer);
				const kept: string[] = [];
				let used = 1; // the ellipsis cell
				for (let index = characters.length - 1; index >= 0; index--) {
					const cell = visibleWidth(characters[index]!);
					if (used + cell > room) break;
					used += cell;
					kept.push(characters[index]!);
				}
				shown = `…${kept.reverse().join("")}`;
			}
			return `${prompt}${shown}${this.theme.fg("accent", "▌")}`;
		}
		if (this.mode === "confirmStop") {
			return this.theme.fg("error", `⚠ stop ${sanitizeLine(row?.agent ?? "this run")} (${sanitizeLine(row?.runId ?? "?").slice(0, 8)})? press D again to confirm`);
		}
		const notice = this.visibleNotice(now);
		if (notice) {
			const tone = notice.tone === "error" ? "error" : notice.tone === "success" ? "success" : "dim";
			return this.theme.fg(tone, notice.text);
		}
		if (row) {
			const channel = this.channelFor(row, now);
			if (this.ownsRun(row) === false && !(channel === "steer" && this.cachedRunnerProbe(row, now))) {
				return dim("view-only · launched by another pi session · o cwd · y copy path");
			}
			// A parked child is not reading its steer inbox — it is blocked in a
			// poll for the reply file. Saying "s steers the running child" there
			// promises delivery to something that cannot take it until the
			// conversation answers; the answer is a tool call this hub does not
			// make, so the row says where the reply belongs. The keys stay
			// advertised: they all still work, and this was the only row that
			// stopped naming them.
			if (this.liveness(row, now) === "parked") {
				// The question, not the enum: `reason` is a token like
				// "interview_request", while `message` is what was actually
				// asked — and the message was being read, bounded and dropped.
				const wait = this.waitFor(row);
				const asked = sanitizeLine(wait?.message || wait?.reason || "");
				const quoted = asked ? ` — “${asked}”` : "";
				return dim(`parked: answer in the conversation${quoted} · i interrupt · D stop · o cwd · y copy path`);
			}
			// "the running child" is a claim, and after an ask ran out with the
			// heartbeat frozen it is exactly the claim nothing supports.
			const explain = this.liveness(row, now) === "unknown"
				? `s sends · ${this.quietLabel(row, now)}`
				: channel === "steer" ? "s steers the running child" : row.state === "running" ? "s revives this stalled run" : "s resumes the conversation";
			return dim(`${explain} · i interrupt · D stop · o cwd · y copy path`);
		}
		return dim("no run selected");
	}

	private runnerProbe: { key: string; at: number; live: boolean } | undefined;

	/** The action row renders every frame; a capability read plus a signal-0
	 * per frame for a foreign run is filesystem work paid 25 times a second
	 * for a value that changes on runner lifecycle. Cached briefly — the send
	 * path always probes fresh, where the answer actually gates a write. */
	private cachedRunnerProbe(row: RunRow, now: number): boolean {
		const key = rowKey(row);
		if (this.runnerProbe?.key === key && now - this.runnerProbe.at < 1500) return this.runnerProbe.live;
		const live = runnerReachable(readCapability(row.dir, row.stepIndex));
		this.runnerProbe = { key, at: now, live };
		return live;
	}

	private stateGlyph(row: RunRow, now: number): string {
		if (row.state !== "running") {
			if (row.state === "complete") return this.theme.fg("success", "✓");
			if (row.state === "failed") return this.theme.fg("error", "✗");
			return this.theme.fg("muted", "■");
		}
		// A parked child reads as running everywhere else — same state, same
		// recorded status — and the whole point of the row is that it is not
		// going to move until someone answers it. Its own glyph, not a tint.
		switch (this.liveness(row, now)) {
			case "parked": return this.theme.fg("accent", "!");
			case "unknown": return this.theme.fg("muted", "?");
			case "stale": return this.theme.fg("muted", "⟳");
			default: return this.theme.fg("warning", "⟳");
		}
	}

	/** The row's state in words. Live rows say what is holding them: parked on
	 * a supervisor reply, detached from an ended run record, or the tool they
	 * are inside. Each of these was previously rendered as the run's own
	 * outcome, which is how a working child came to be labelled "failed". */
	private stateLabel(row: RunRow, now: number): string {
		if (row.state !== "running") return row.state;
		const detached = row.detached ? " · detached" : "";
		switch (this.liveness(row, now)) {
			case "parked": return `waiting on you${detached}`;
			// Neither "stale" nor "waiting" is knowable here: the ask ran out
			// and the heartbeat froze *because of* the ask, so it is evidence
			// of nothing. Say how long it has been quiet and let the reader
			// judge — asserting either would be inventing a measurement.
			case "unknown": return `${this.quietLabel(row, now)}${detached}`;
			case "stale": return "stale";
			default: return `${row.currentTool ?? "…"}${detached}`;
		}
	}

	/** The same verdict for the chat header, where the current tool is already
	 * on screen below and the word the reader needs is the state itself. */
	private headerLabel(row: RunRow, now: number): string {
		if (row.state !== "running" || this.liveness(row, now) !== "live") return this.stateLabel(row, now);
		return row.detached ? "running · detached" : "running";
	}

	private renderList(width: number, fullHeight: number, now: number): string[] {
		const dim = (text: string): string => this.theme.fg("dim", text);
		// Reserve the notice's line up front. Overwriting the last row instead
		// erased the selection when the cursor was on it — the list lost its
		// cursor entirely at the moment the notice appeared.
		const capped = this.rows.length === MAX_ROWS;
		const height = Math.max(2, capped ? fullHeight - 1 : fullHeight);
		if (this.rows.length === 0) {
			if (this.scope === "session" && this.rpc.sessionId === undefined) {
				return [dim("session not identified yet"), dim("the bridge has not named this session"), dim("r retries · f changes scope")];
			}
			return [dim(`no runs ${this.scope === "machine" ? "found" : this.scope === "project" ? "in this project" : "in this session"}`), dim("f changes scope"), dim("q closes")];
		}
		// Two lines per entry, the way omp's roster reads: the name row with
		// the model and recency right-aligned, then a dim per-run stats row.
		const visibleEntries = Math.max(1, Math.floor(height / 2));
		const selectedIndex = Math.max(0, this.rows.findIndex(row => rowKey(row) === this.selectedKey));
		if (selectedIndex < this.listWindowTop) this.listWindowTop = selectedIndex;
		if (selectedIndex >= this.listWindowTop + visibleEntries) this.listWindowTop = selectedIndex - visibleEntries + 1;
		this.listWindowTop = Math.max(0, Math.min(this.listWindowTop, Math.max(0, this.rows.length - visibleEntries)));

		const lines: string[] = [];
		for (let index = this.listWindowTop; index < Math.min(this.rows.length, this.listWindowTop + visibleEntries); index++) {
			const row = this.rows[index]!;
			const selected = index === selectedIndex;
			const marker = selected ? this.theme.fg("accent", "▸") : " ";
			// Agent, tool, state and model strings come from another extension's
			// status.json — from names a model may have picked. A control byte
			// there clears the user's screen mid-frame; strip before drawing.
			const agent = sanitizeLine(row.agent);
			const name = selected ? this.theme.bold(agent) : agent;
			const age = formatAge(row.lastActivityAt ?? row.lastUpdate, now);
			const model = sanitizeLine([shortModel(row.model), row.thinking].filter(Boolean).join(" ⏻ "));
			// Right-aligned model · age; the model yields first when the pane is
			// too narrow to hold both it and a readable name.
			let right = [model, age].filter(Boolean).join(" · ");
			if (right && visibleWidth(right) > width - 10) right = age;
			const rightStyled = right ? dim(right) : "";
			const leftBudget = Math.max(4, width - (right ? visibleWidth(right) + 1 : 0) - 3);
			const nameShown = truncateToWidth(name, leftBudget);
			const gap = Math.max(1, width - 3 - visibleWidth(nameShown) - visibleWidth(right));
			lines.push(truncateToWidth(`${marker}${this.stateGlyph(row, now)} ${nameShown}${" ".repeat(gap)}${rightStyled}`, width));

			const detail = sanitizeLine(this.stateLabel(row, now));
			const step = row.stepCount > 1 ? `#${row.stepIndex} · ` : "";
			const active = row.startedAt !== undefined ? formatDuration((row.lastActivityAt ?? row.lastUpdate ?? row.startedAt) - row.startedAt) : "";
			const meter = this.usageFor(row.sessionFile);
			const cost = meter && (meter.done || meter.totals.cost > 0)
				? `${formatCost(meter.totals.cost)}${meter.done ? "" : "…"}`
				: row.sessionFileExists ? "$…" : undefined;
			const records = this.recordCounts.get(rowKey(row));
			const statsParts = [
				`${step}${detail}`,
				// Honest about the merge: this row speaks for more than one run
				// record of the same conversation (a revival and its original).
				...(records !== undefined ? [`${records} records`] : []),
				...(cost ? [cost] : []),
				...(active ? [`${active} active`] : []),
				...(row.turnCount !== undefined ? [`${row.turnCount} req`] : []),
				...(row.toolCount !== undefined ? [`${row.toolCount} tools`] : []),
			];
			lines.push(truncateToWidth(`   ${dim(statsParts.join(" · "))}`, width));
		}
		// Inside the budget, not appended past it: a line beyond the frame's
		// height is cropped and the notice never reaches the reader.
		if (capped) {
			while (lines.length < height) lines.push("");
			// Key first: at narrow panes the tail is what truncation eats, and
			// the recovery key is the half the notice exists to advertise.
			lines.push(dim(`r rescans · newest ${MAX_ROWS} shown`));
		}
		return lines;
	}

	private chatOptions() {
		return {
			tui: this.tui,
			// Sanitized like every other status.json string: the components build
			// OSC-8 file links from it, and a real path is unchanged by the strip.
			cwd: sanitizeLine(this.selectedRow()?.cwd ?? process.cwd()),
			expandedTools: this.expandedTools,
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
		const state = sanitizeLine(this.headerLabel(row, now));
		const meter = this.usageFor(row.sessionFile);
		const usage = meter && (meter.done || meter.totals.cost > 0)
			? ` · ${formatCost(meter.totals.cost)}${meter.done ? "" : "…"} · ${formatTokens(meter.totals.tokens)} tok`
			: "";
		const header = `${this.theme.fg("toolTitle", this.theme.bold(sanitizeLine(row.agent)))} ${dim(`· ${state}${row.model ? ` · ${sanitizeLine(row.model)}` : ""}${usage} · ${sanitizeLine(row.runId).slice(0, 8)}`)}`;
		// The reason under the verdict. A bare "failed" is the start of a
		// question whose answer is already in the artifact — "completed without
		// making edits for an implementation task" — and reading it should not
		// mean opening a temp file. Only where it adds something: a running row
		// wears its state, and a reason under it would be about the wrapper.
		//
		// Computed BEFORE the budget, because it spends a row of it. Taken out
		// of the view afterwards instead, it ate the newest line of the
		// conversation while `lastPaneHeight` and `lastChatHeight` still
		// claimed the taller pane — the scroll indicator vanished, paging
		// overshot by a line, and on a 3-row body the conversation left the
		// screen entirely.
		// Shed below four rows: the `Math.max(1, …)` floor cannot absorb the
		// extra line, so keeping it there emitted one row more than the caller
		// budgeted and the clip landed on the conversation instead. A reason
		// with no conversation under it is not the trade to make.
		const reason = row.state !== "running" && row.error !== undefined && height >= 4
			? [truncateToWidth(dim(`why: ${sanitizeLine(row.error)}`), width)]
			: [];
		const paneHeight = Math.max(1, height - 2 - reason.length);
		this.lastPaneHeight = paneHeight;
		// One row is reserved for the scroll indicator, and a block for the live
		// output tail — reserved, not overwritten, so neither costs content.
		const liveLines = this.follow && this.maybeLive(row, now) ? (this.liveOutput?.lines ?? []) : [];
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
					scroll: this.chatScroll,
					liveStamp,
					lines: built.lines,
					linesKnown: built.linesKnown,
					atOldest: built.atOldest,
				};
			}
			body.push(...this.chatMemo!.lines);
			if (this.chatMemo!.lines.length === 0) {
				// Offer the revive only where `s` actually revives: a parked or
				// merely quiet child is alive, and telling the reader to revive
				// one is the same lie the row above no longer tells.
				body.push(dim(this.maybeLive(row, now) ? "no conversation recorded yet" : "no conversation recorded — s revives this run"));
			}
		}

		const filled = [...body];
		while (filled.length < viewHeight) filled.push("");
		const view = filled.slice(0, viewHeight);
		if (this.chatScroll > 0) view.push(truncateToWidth(dim(`↓ ${this.chatScroll} newer lines · G to follow`), width));
		if (liveLines.length > 0) {
			view.push(truncateToWidth(dim(`┈ live output (${sanitizeLine(path.basename(this.liveOutputFile ?? "output"))})`), width));
			for (const line of liveLines) view.push(truncateToWidth(dim(line), width));
		}
		while (view.length < paneHeight) view.push("");
		return [truncateToWidth(header, width), ...reason, "", ...view.slice(0, paneHeight)];
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
		this.waits.clear();
		this.waitDirs.clear();
		this.recordCounts.clear();
	}
}

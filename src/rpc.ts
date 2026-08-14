// The client half of the subagents extension's cross-extension RPC: a
// versioned envelope on pi's event bus. Verified live — see DESIGN.md.
//
// The bridge answers on `subagents:rpc:v1:reply:<requestId>` exactly once per
// request, and announces itself with a capability manifest on
// `subagents:rpc:v1:ready`. Absence is a normal state (extension not
// installed, or not yet loaded), so every call resolves rather than throwing:
// `undefined` means nobody answered.

const REQUEST_EVENT = "subagents:rpc:v1:request";
const REPLY_PREFIX = "subagents:rpc:v1:reply:";
const READY_EVENT = "subagents:rpc:v1:ready";

/** The slice of pi's EventBus this client needs. */
export interface RpcEvents {
	on(event: string, handler: (data: unknown) => void): () => void;
	emit(event: string, data: unknown): void;
}

export interface RpcReply {
	success: boolean;
	data?: Record<string, unknown>;
	error?: { code?: string; message?: string };
}

export interface FleetEntry {
	key?: string;
	agent?: string;
	model?: string;
	startedAt?: number;
	goal?: string;
	tokens?: { total?: number };
}

export interface FleetSnapshot {
	/** Someone answered the request — distinct from "answered with zero runs". */
	available: boolean;
	totalActive?: number;
	entries: FleetEntry[];
}

/** A control call's outcome, reduced to what the action row can say. */
export interface ActionOutcome {
	ok: boolean;
	/** Nobody answered at all — the extension is absent or not ready. */
	unreachable?: boolean;
	/** First line of the bridge's own wording, or the error message. */
	text: string;
	steering?: { requestId?: string; state?: string; deliveryStatus?: string };
}

export interface RunTarget {
	id: string;
	index?: number;
}

/** Broadcasts the bridge emits when a run finishes or its process ends —
 * names read from the ready manifest, stable within protocol v1. */
const RUN_EVENTS = ["subagent:async-complete", "subagent:process-terminal"];

let requestCounter = 0;

export class SubagentsRpc {
	private readonly offReady: () => void;
	private manifestSeen = false;
	private identifyAttempts = 0;
	/** Reply subscriptions still waiting; dispose releases them rather than
	 * leaving handlers on pi's global bus until their timeouts fire. */
	private readonly pending = new Set<() => void>();
	/** The session the bridge lives in. Control is scoped to it upstream, so
	 * ownership decides which runs the RPC will act on at all. */
	sessionId: string | undefined;

	private readonly events: RpcEvents;

	constructor(events: RpcEvents) {
		this.events = events;
		this.offReady = events.on(READY_EVENT, raw => {
			this.manifestSeen = true;
			this.captureSession(raw);
		});
	}

	private captureSession(raw: unknown): void {
		const session = (raw as { session?: { sessionId?: unknown; sessionFile?: unknown } } | undefined)?.session;
		// Upstream's session identity is the session FILE when one exists, the
		// UUID only as a fallback (`resolveCurrentSessionId`) — and the file is
		// what run statuses record. Comparing the UUID against a recorded path
		// called every run foreign, including this session's own.
		if (typeof session?.sessionFile === "string" && session.sessionFile) this.sessionId = session.sessionFile;
		else if (typeof session?.sessionId === "string") this.sessionId = session.sessionId;
	}

	/** A user-invoked rescan re-arms identification: the budget exists to stop
	 * silent background re-pinging, not to make an early "no session yet"
	 * verdict permanent for the life of the overlay. */
	resetIdentify(): void {
		this.identifyAttempts = 0;
	}

	/** One ping to learn the session id when the ready broadcast predates us.
	 * Bounded on ANSWERS that carried no session — a bridge with no UI context
	 * yet would otherwise be re-pinged every refresh tick forever. Timeouts do
	 * not spend the budget: a bridge that was busy at startup can still be
	 * identified once it starts answering. */
	async identify(): Promise<void> {
		if (this.sessionId !== undefined || this.identifyAttempts >= 3) return;
		const reply = await this.call("ping", undefined, 3000);
		if (reply?.success) {
			this.captureSession(reply.data);
			if (this.sessionId === undefined) this.identifyAttempts++;
		}
	}

	/** Whether the bridge has announced itself this process — a hint, not a
	 * gate: a bridge that loaded before this client announces to nobody. */
	get announced(): boolean {
		return this.manifestSeen;
	}

	call(method: string, params?: unknown, timeoutMs = 3000): Promise<RpcReply | undefined> {
		const requestId = `pi-agent-hub-${Date.now()}-${requestCounter++}`;
		return new Promise(resolve => {
			let settled = false;
			const finish = (reply: RpcReply | undefined): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				this.pending.delete(unsubscribe);
				unsubscribe();
				resolve(reply);
			};
			const unsubscribe = this.events.on(`${REPLY_PREFIX}${requestId}`, raw => {
				finish(typeof raw === "object" && raw !== null ? (raw as RpcReply) : { success: false });
			});
			this.pending.add(unsubscribe);
			const timer = setTimeout(() => finish(undefined), timeoutMs);
			this.events.emit(REQUEST_EVENT, {
				version: 1,
				requestId,
				method,
				...(params === undefined ? {} : { params }),
				source: { extension: "pi-agent-hub" },
			});
		});
	}

	/** The structured fleet from `status`, reduced to what the hub shows. */
	async fleet(): Promise<FleetSnapshot> {
		const reply = await this.call("status", {});
		if (reply === undefined) return { available: false, entries: [] };
		const fleet = (reply.data?.fleet ?? {}) as { totalActive?: number; entries?: FleetEntry[] };
		return {
			available: true,
			...(typeof fleet.totalActive === "number" ? { totalActive: fleet.totalActive } : {}),
			entries: Array.isArray(fleet.entries) ? fleet.entries : [],
		};
	}

	/** One notification per run-lifecycle broadcast, so the list can refresh
	 * the moment a run finishes instead of on the next scan tick. */
	onRunEvents(handler: () => void): () => void {
		const offs = RUN_EVENTS.map(event => this.events.on(event, handler));
		return () => {
			for (const off of offs) off();
		};
	}

	private async action(method: string, params: Record<string, unknown>): Promise<ActionOutcome> {
		const reply = await this.call(method, params, 10_000);
		if (reply === undefined) return { ok: false, unreachable: true, text: "no answer from the subagents extension" };
		if (!reply.success) return { ok: false, text: typeof reply.error?.message === "string" ? reply.error.message : `subagents rejected the ${method}` };
		const data = reply.data ?? {};
		const details = (data.details ?? {}) as { steering?: ActionOutcome["steering"] };
		const text = String((data as { text?: unknown }).text ?? "").split("\n")[0] ?? "";
		return { ok: true, text, ...(details.steering ? { steering: details.steering } : {}) };
	}

	steer(target: RunTarget, message: string, mode: "steer" | "follow_up" | "auto" = "auto"): Promise<ActionOutcome> {
		return this.action("steer", { ...target, message, mode });
	}

	resume(target: RunTarget, message: string): Promise<ActionOutcome> {
		return this.action("resume", { id: target.id, message });
	}

	interrupt(target: RunTarget): Promise<ActionOutcome> {
		return this.action("interrupt", { ...target });
	}

	stop(target: RunTarget): Promise<ActionOutcome> {
		return this.action("stop", { ...target });
	}

	dispose(): void {
		this.offReady();
		for (const unsubscribe of this.pending) unsubscribe();
		this.pending.clear();
	}
}

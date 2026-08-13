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

let requestCounter = 0;

export class SubagentsRpc {
	private readonly offReady: () => void;
	private manifestSeen = false;

	constructor(private readonly events: RpcEvents) {
		this.offReady = events.on(READY_EVENT, () => {
			this.manifestSeen = true;
		});
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
				unsubscribe();
				resolve(reply);
			};
			const unsubscribe = this.events.on(`${REPLY_PREFIX}${requestId}`, raw => {
				finish(typeof raw === "object" && raw !== null ? (raw as RpcReply) : { success: false });
			});
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

	dispose(): void {
		this.offReady();
	}
}

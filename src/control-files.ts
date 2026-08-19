// The file half of the control plane: capability and acknowledgment files the
// detached runner writes, and — as a fallback only — the request files it
// consumes. The shapes mirror the foreign extension's control-channel module
// (verified against pi-subagents 0.46.0); every write is atomic and confined
// to a run's own `control/` inbox, which exists precisely to be written to by
// other processes. Session files are never touched.
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/** The runner's declaration that a child accepts live steering. */
export interface SteerCapability {
	index: number;
	pid: number;
	readyAt: number;
	supported: boolean;
}

export interface SteerAck {
	state: "delivered" | "queued" | "failed";
	message?: string;
	deliveryStatus?: string;
}

const MAX_STEER_MESSAGE_BYTES = 128 * 1024;
/** Upstream's queue cap, enforced here on the request directory as well —
 * the child runtime bounds only its own follow-up queue, and this writer is
 * the one surface that touches a run another session owns. */
const MAX_QUEUED_REQUESTS = 20;

function controlDir(runDir: string): string {
	return path.join(runDir, "control");
}

export function readCapability(runDir: string, index: number): SteerCapability | undefined {
	try {
		const raw = JSON.parse(fs.readFileSync(path.join(controlDir(runDir), "steer-capabilities", `${index}.json`), "utf8")) as Partial<SteerCapability>;
		if (typeof raw.pid !== "number" || typeof raw.supported !== "boolean") return undefined;
		return { index, pid: raw.pid, readyAt: typeof raw.readyAt === "number" ? raw.readyAt : 0, supported: raw.supported };
	} catch {
		return undefined;
	}
}

/** Whether the process that declared the capability is still alive. Signal 0
 * delivers nothing — it only asks the kernel if the pid exists. EPERM means
 * the pid exists but belongs to someone this user cannot signal: alive for
 * our purposes, since the runner reads its inbox regardless of who we are. */
export function runnerReachable(capability: SteerCapability | undefined): boolean {
	if (!capability?.supported || capability.pid <= 0) return false;
	try {
		process.kill(capability.pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** The inbox owner marks it closed when the run settles; a request written
 * after that would sit unread forever. */
export function steerInboxClosed(runDir: string): boolean {
	return fs.existsSync(path.join(controlDir(runDir), "steer-inbox-closed.json"));
}

function base64url(value: string): string {
	return Buffer.from(value).toString("base64url");
}

/** Find the LATEST acknowledgment for a request, whoever wrote it.
 *
 * One request produces a file per state transition — queued, then delivered
 * or failed — named `<base64url(requestId)>-<ts13>-<order>-<state>[…].json`,
 * so the timestamp-then-order suffix sorts chronologically and the last file
 * is the request's current state. Returning whichever the directory yielded
 * first announced a failed steer as "queued". */
export function findAck(runDir: string, index: number, requestId: string): SteerAck | undefined {
	const dir = path.join(controlDir(runDir), "steer-acks", String(index));
	let names: string[];
	try {
		names = fs.readdirSync(dir);
	} catch {
		return undefined;
	}
	const prefix = `${base64url(requestId)}-`;
	const matches = names.filter(name => name.startsWith(prefix)).sort();
	for (let index = matches.length - 1; index >= 0; index--) {
		try {
			const raw = JSON.parse(fs.readFileSync(path.join(dir, matches[index]!), "utf8")) as Partial<SteerAck>;
			if (raw.state === "delivered" || raw.state === "queued" || raw.state === "failed") {
				return { state: raw.state, ...(typeof raw.message === "string" ? { message: raw.message } : {}), ...(typeof raw.deliveryStatus === "string" ? { deliveryStatus: raw.deliveryStatus } : {}) };
			}
		} catch {
			// Mid-write or malformed; try the transition before it.
		}
	}
	return undefined;
}

function writeAtomicJson(filePath: string, value: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const temp = path.join(path.dirname(filePath), `.tmp-hub-${process.pid}-${Date.now()}`);
	fs.writeFileSync(temp, JSON.stringify(value), "utf8");
	fs.renameSync(temp, filePath);
}

/** Fallback steer for a runner no bridge can reach: drop the request file the
 * runner's inbox watcher consumes. Returns the request id acks are keyed on. */
export function writeSteerRequestFile(runDir: string, message: string, targetIndex?: number): string {
	if (Buffer.byteLength(message, "utf8") > MAX_STEER_MESSAGE_BYTES) {
		throw new Error("message exceeds the steer transport limit (128 KB)");
	}
	const requestsDir = path.join(controlDir(runDir), "steer-requests");
	try {
		if (fs.readdirSync(requestsDir).filter(name => name.endsWith(".json")).length >= MAX_QUEUED_REQUESTS) {
			throw new Error(`the run's steer inbox is full (${MAX_QUEUED_REQUESTS} queued and unread)`);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const id = randomUUID();
	const ts = Date.now();
	const request = {
		type: "steer" as const,
		id,
		ts,
		message,
		mode: "auto" as const,
		...(targetIndex !== undefined ? { targetIndex } : {}),
		source: "pi-agent-hub",
	};
	writeAtomicJson(path.join(controlDir(runDir), "steer-requests", `${String(ts).padStart(13, "0")}-${base64url(id)}.json`), request);
	return id;
}

/** Fallback interrupt/stop: the portable request files the runner watches. */
export function writeControlRequest(runDir: string, kind: "interrupt" | "stop", reason: string, targetIndex?: number): void {
	writeAtomicJson(path.join(controlDir(runDir), `${kind}.json`), {
		type: kind,
		ts: Date.now(),
		source: "pi-agent-hub",
		reason,
		...(targetIndex !== undefined ? { targetIndex } : {}),
	});
}

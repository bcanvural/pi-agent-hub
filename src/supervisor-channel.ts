// Whether a child is parked waiting for the supervisor to answer it.
//
// A child running `contact_supervisor` writes `requests/<id>.json` and then
// blocks polling for `replies/<id>.json` (upstream `native-supervisor-channel`).
// An unanswered request that expects a reply and has not passed its deadline
// therefore means the child is stopped, waiting on this session's operator —
// fire-and-forget progress updates and expired asks sit in the same directory
// and mean no such thing (see `readRequest` and `waitExpired`). Nothing else
// in the artifacts says so — status.json carries `activityState: "needs_attention"`
// only when a detached runner hosts the run, and a parent-hosted run (the
// common case: every fresh child) never gets it.
//
// This module only ever reads. Answering a request is the parent's own tool
// call, and a reply written from here would race the extension's watcher for a
// request it has already taken — the hub reports the wait, the conversation
// resolves it.
import * as fs from "node:fs";
import * as path from "node:path";
import { tempRoot } from "./runs.ts";

/** A request the child is still blocked on. */
export interface SupervisorWait {
	requestId: string;
	/** "need_decision" | "interview_request" | "progress_update" upstream, but
	 * treated as free text: it is rendered, not switched on. */
	reason: string;
	message: string;
	createdAt: number;
	/** When the child's own poll gives up. Absent only if the request predates
	 * the field or could not be dated — see `waitExpired`. */
	expiresAt: number | undefined;
}

/** Upstream's default ask timeout, measured on a real envelope
 * (`expiresAt - createdAt === 600000`). Used only to date a request that
 * carries no `expiresAt` of its own. */
const DEFAULT_ASK_TIMEOUT_MS = 600_000;

/** Past its deadline the child's poll has thrown and it has moved on: whatever
 * else is true, it is no longer parked on this. A request that cannot be dated
 * at all counts as expired — a live park is a claim, and an undatable file is
 * not evidence for it. */
export function waitExpired(wait: SupervisorWait, now: number): boolean {
	if (wait.expiresAt !== undefined) return now >= wait.expiresAt;
	if (wait.createdAt > 0) return now >= wait.createdAt + DEFAULT_ASK_TIMEOUT_MS;
	return true;
}

/** Enough to say what is being asked without holding the whole ask: the row
 * shows one line of it, and a supervisor message can run to kilobytes. Applied
 * to every rendered field — bounding the one the consumer ignores while the
 * rendered one runs to 200k puts that string through the sanitizer every
 * frame. Sliced by code point: a cut inside a surrogate pair renders one
 * column wider than `visibleWidth` reports. */
const MAX_MESSAGE_CHARS = 240;

/** The part of the envelope a person is meant to read. Upstream prefixes the
 * child's message with a metadata header (Run:/Agent:/Child index:) separated
 * by a blank line; quoting from the top rendered 240 characters of ids with
 * their newlines deleted — "decision.Run: d2631a9a…Agent: df-reviewer…" — and
 * the actual question never made the row. Newlines collapse to spaces because
 * the destination is one row: sanitizeLine would DELETE them and fuse words. */
function displayBody(value: unknown): string {
	if (typeof value !== "string") return "";
	// A blank line by any spelling: upstream writes "\n\n", but a foreign
	// runner writing CRLF ("\r\n\r\n" contains no "\n\n") got exactly the
	// metadata leak this function was written to remove.
	const separator = /(?:\r?\n|[\u2028\u2029])[ \t]*(?:\r?\n|[\u2028\u2029])/.exec(value);
	const body = separator ? value.slice(separator.index + separator[0].length) : value;
	const flat = body.replace(/\s+/g, " ").trim();
	// Judged empty by what a reader can SEE: a body of zero-width spaces is
	// "non-empty" to \s and rendered an invisible quotation. Zero-widths are
	// stripped only for this test, never from the output — ZWJ binds emoji
	// clusters and removing it would break them.
	const visible = flat.replace(/[\u200b-\u200d\u2060\ufeff]/g, "");
	if (visible) return flat;
	return value.replace(/\s+/g, " ").trim();
}

function clip(value: unknown): string {
	if (typeof value !== "string") return "";
	// Length-guarded before any allocation. `Array.from` over the whole string
	// materialised an array the size of the foreign field just to discover it
	// needed clipping — 26ms per probe on a 240KB request, the same order as
	// the 1.2s event-loop stall invariant 5 was written for. A code point is at
	// most two UTF-16 units, so the first MAX points always live inside the
	// first 2*MAX units: slicing there first bounds the work without changing
	// the result.
	if (value.length <= MAX_MESSAGE_CHARS) return value;
	const points = Array.from(value.slice(0, MAX_MESSAGE_CHARS * 2));
	return points.length > MAX_MESSAGE_CHARS ? points.slice(0, MAX_MESSAGE_CHARS).join("") : points.join("");
}
/** A request file is a small JSON envelope. Anything larger is not one, and
 * reading it on the render path would be the cost this bound exists to refuse. */
const MAX_REQUEST_BYTES = 256 * 1024;
/** Bound on entries examined per probe. The directory holds one pending
 * request in practice; a directory that somehow holds thousands must not turn
 * a list tick into a filesystem sweep. */
const MAX_REQUESTS_SCANNED = 32;
/** Hard bound on directory entries examined, so that counting candidates
 * rather than entries cannot buy an unbounded number of stats. */
const MAX_ENTRIES_SCANNED = 512;

function channelRoot(): string {
	return path.join(tempRoot(), "supervisor-channels");
}

/** Upstream's own segment sanitizer, mirrored: the directory name is built
 * from it at launch, so any divergence here silently probes a path that never
 * exists — an absent wait, reported as calm. */
function sanitizeSegment(value: string): string {
	return value.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

/** The candidate channels for a step, in preference order. Two, because two
 * naming schemes coexist on real disks: a revived run's channel is keyed by
 * the RUN's own id and the step's index (`207f8b12-worker-sol-0`), while a
 * workflow child's is keyed by the child's own run id from its session path,
 * `…/<childRunId>/run-<childIndex>/session.jsonl` (`3dff7950-df-worker-0`).
 * Which candidate a row actually owns is decided by the caller, by which one
 * YIELDS a wait passing `belongsTo` — never by directory existence (upstream
 * garbage-collects empty channels after 60s) and never assumed from here. */
export function supervisorChannels(runId: string, stepIndex: number, sessionFile: string | undefined, agent: string | undefined): SupervisorChannel[] {
	// Identity, so the recorded name only — a display fallback ("agent", or the
	// step's label) matches the directory after sanitizing and is then rejected
	// by `belongsTo`, which reads as calm rather than as the mismatch it is.
	if (!agent) return [];
	// The index is the one path segment built without a sanitizer; anything
	// but digits ("-1", "NaN", "1e+21") would be interpolated into a directory
	// name upstream can never have created and probed without complaint.
	const digits = (value: string): boolean => /^\d+$/.test(value);
	const build = (childRunId: string, childIndex: string): SupervisorChannel => ({
		dir: path.join(channelRoot(), `${sanitizeSegment(childRunId)}-${sanitizeSegment(agent)}-${childIndex}`),
		childRunId,
		agent,
		// The digits from the path, not their numeric value: `run-007` names a
		// directory ending in "007" while Number() would claim 7, so the two
		// halves of one identity must not be derived differently.
		childIndex,
	});
	const candidates: SupervisorChannel[] = [];
	const indexFromPath = sessionFile !== undefined
		? /^run-(\d+)$/.exec(path.basename(path.dirname(sessionFile)))?.[1]
		: undefined;
	// The run's own id FIRST. The channel is keyed by the id the launch used,
	// and a revived run launches under its own id while inheriting the original
	// child's session file — so the session path names the ORIGINAL child's
	// channel, which the revival neither owns nor writes to. Probing that one
	// first made a revived run's waits unreachable and showed the original's
	// question under both rows.
	//
	// Its index is the STEP's position in the run, not the session path's
	// digits. The path always reads `run-0` — every child gets a fresh session
	// root — while a run-id-keyed channel is keyed by the child's index within
	// the run (upstream's `flatIndex`), so borrowing the path's zero collapsed
	// every same-agent sibling of a fan-out onto one channel.
	if (runId && digits(String(stepIndex))) candidates.push(build(runId, String(stepIndex)));
	if (sessionFile !== undefined && indexFromPath !== undefined) {
		const childRunId = path.basename(path.dirname(path.dirname(sessionFile)));
		if (childRunId && childRunId !== "." && childRunId !== path.sep && childRunId !== runId) {
			candidates.push(build(childRunId, indexFromPath));
		}
	}
	return candidates;
}

// Selecting between candidates by DIRECTORY EXISTENCE was wrong and had a
// sixty-second half-life: upstream's watcher deletes any channel that is empty
// and older than `STALE_EMPTY_CHANNEL_AGE_MS` (60s,
// `cleanupStaleEmptySupervisorChannels`), so a revived run that has not yet
// contacted a supervisor loses its own directory and the candidate list falls
// back to the inherited child's — restoring the exact misattribution the
// candidate list exists to prevent, one minute after every spawn. Not one of
// the eight real channels on this machine is empty, which is what that GC
// leaves behind. Ownership is decided by which candidate ANSWERS, validated by
// `belongsTo`; existence answers a different question.

/** Which child a channel belongs to. Carried alongside the directory because
 * the directory NAME cannot answer it: `sanitizeSegment` is many-to-one, so
 * two children whose ids or agent names differ only in punctuation ("twin A"
 * and "twin-A") land on the same path — and one child's question then renders
 * on the other's row. The request envelope names its own runId, agent and
 * childIndex, so the collision is detectable at the point of attribution. */
export interface SupervisorChannel {
	dir: string;
	childRunId: string;
	agent: string;
	/** The digits as they appear in the path, so the identity and the directory
	 * name are derived from one value. */
	childIndex: string;
}

function belongsTo(record: Record<string, unknown>, channel: SupervisorChannel): boolean {
	// Only a field that is present AND disagrees rejects: an envelope that
	// omits its identity is old, not foreign.
	if (typeof record.runId === "string" && record.runId !== channel.childRunId) return false;
	if (typeof record.agent === "string" && record.agent !== channel.agent) return false;
	if (typeof record.childIndex === "number" && String(record.childIndex) !== String(Number(channel.childIndex))) return false;
	return true;
}

function readRequest(file: string, channel: SupervisorChannel): SupervisorWait | undefined {
	let stat: fs.Stats;
	try {
		stat = fs.statSync(file);
	} catch {
		return undefined;
	}
	if (!stat.isFile() || stat.size > MAX_REQUEST_BYTES) return undefined;
	let raw: unknown;
	try {
		raw = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
	if (typeof raw !== "object" || raw === null) return undefined;
	const record = raw as Record<string, unknown>;
	const id = typeof record.id === "string" && record.id ? record.id : undefined;
	// The id is interpolated into a path to look for the reply. A foreign id
	// carrying a separator escapes the replies directory, and one that lands on
	// an existing file reports an unanswered request as answered — a parked
	// child, rendered calm. Upstream ids are UUIDs; anything that is not a
	// plain filename is not one.
	// A NUL or other control byte is not a filename on any filesystem, and
	// `path.basename` passes it through unchanged.
	if (!id || id !== path.basename(id) || id === "." || id === ".." || /[\u0000-\u001f\u007f]/.test(id)) return undefined;
	// `progress_update` is fire-and-forget: upstream sets expectsReply false and
	// the child returns without blocking (native-supervisor-channel.ts). Its
	// request file sits in the same directory and means nobody is waiting.
	// Any falsy value reads the same way; only an absent field is permissive.
	if (record.expectsReply !== undefined && !record.expectsReply) return undefined;
	// The envelope names the child it came from; a directory name cannot.
	if (!belongsTo(record, channel)) return undefined;
	const number = (value: unknown): number | undefined =>
		// A foreign number is not a timestamp until it is one; an Infinity here
		// would render as an age from the end of time.
		typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
	return {
		requestId: id,
		reason: clip(record.reason),
		message: clip(displayBody(record.message)),
		createdAt: number(record.createdAt) ?? 0,
		expiresAt: number(record.expiresAt),
	};
}

/** The request this child is parked on, or undefined if it is not parked. */
export function readSupervisorWait(channel: SupervisorChannel | undefined, now = Date.now()): SupervisorWait | undefined {
	if (!channel) return undefined;
	const channelDir = channel.dir;
	let names: string[];
	try {
		names = fs.readdirSync(path.join(channelDir, "requests"));
	} catch {
		// No channel, or none yet: this child never contacted a supervisor.
		return undefined;
	}
	// The budget counts CANDIDATES, not directory entries. Filtering junk
	// before the bound was not enough: an answered leftover is a well-formed
	// `.json` that survives to be read and then discarded, so a channel holding
	// 40 of them spent the whole budget before reaching the one live request —
	// deterministically, since readdir returns sorted names, leaving a parked
	// child invisible on every probe rather than one in five. The reply file
	// carries the request's own name, so the name alone settles it without a
	// read. The entry scan is bounded too: an unbounded directory must not buy
	// an unbounded number of stats.
	const candidates: string[] = [];
	for (let index = 0; index < names.length && index < MAX_ENTRIES_SCANNED && candidates.length < MAX_REQUESTS_SCANNED; index++) {
		const name = names[index]!;
		if (!name.endsWith(".json")) continue;
		if (fs.existsSync(path.join(channelDir, "replies", name))) continue;
		candidates.push(name);
	}
	const pending: SupervisorWait[] = [];
	for (const name of candidates) {
		const request = readRequest(path.join(channelDir, "requests", name), channel);
		if (!request) continue;
		// Re-checked against the id inside the envelope: the file name is only a
		// convention, and a reply that outlives its request must never read as a
		// live wait.
		if (request.requestId !== path.basename(name, ".json")
			&& fs.existsSync(path.join(channelDir, "replies", `${request.requestId}.json`))) continue;
		pending.push(request);
	}
	if (pending.length === 0) return undefined;
	// A live ask always outranks a dead one — a newer request the child has
	// already given up on must not displace an older one it is still blocked
	// in. Within a group, newest first: a child blocks on one ask at a time, so
	// a second can only exist once the first was answered or abandoned, and
	// quoting the older leftover puts the wrong question in front of the
	// reader. Undatable requests sort last; they are expired by definition.
	// Expired ones are still RETURNED, not dropped: the caller needs to know an
	// unanswered ask is sitting there to say "no answer for 9m" instead of
	// asserting the child is stale, which is a claim about death that a park
	// makes unmeasurable.
	const asked = (wait: SupervisorWait): number => (wait.createdAt > 0 ? wait.createdAt : -1);
	pending.sort((left, right) => {
		const liveness = Number(waitExpired(left, now)) - Number(waitExpired(right, now));
		return liveness !== 0 ? liveness : asked(right) - asked(left);
	});
	return pending[0];
}

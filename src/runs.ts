// Where runs are found and what a row in the hub's list is.
//
// The list is driven from disk — each run's status.json carries everything a
// row needs (runId, per-step sessionFile, current tool, activity stamps) where
// the RPC's fleet entries carry none of it. The RPC supplements liveness; this
// module supplies identity.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** What a row IS, in one vocabulary. Upstream spells the same outcome two
 * ways depending on where it is written ("complete" at run level, "completed"
 * on a step), and only steps carry "pending"/"rejected". */
export type RowState = "pending" | "running" | "complete" | "failed" | "stopped" | "paused" | "rejected" | "unknown";

const ROW_STATES: Record<string, RowState> = {
	pending: "pending",
	queued: "pending",
	running: "running",
	complete: "complete",
	completed: "complete",
	failed: "failed",
	stopped: "stopped",
	paused: "paused",
	rejected: "rejected",
};

/** Run-level states that mean the run record is over. A step still reporting
 * "running" under one of these is not finished — it is detached (see below). */
const RUN_OVER = new Set<RowState>(["complete", "failed", "stopped", "rejected"]);

/** `hasOwn` is load-bearing: a plain object literal answers for its prototype
 * too, so a step whose status reads "constructor" or "toString" returned a
 * FUNCTION as this row's state. That value reached `sanitizeLine` at the render
 * site and threw `line.replace is not a function` out of render — the host
 * session, killed by one word in a foreign file (invariant 1, invariant 7). */
function normalizeState(raw: string | undefined): RowState | undefined {
	return raw !== undefined && Object.hasOwn(ROW_STATES, raw) ? ROW_STATES[raw] : undefined;
}

/** One selectable row: a single step of an async run. */
export interface RunRow {
	runId: string;
	stepIndex: number;
	stepCount: number;
	agent: string;
	/** The step's agent name as recorded, with no display fallback. Identity,
	 * not a label: the supervisor channel is keyed by the real launch name, so
	 * matching a channel against `agent` (which falls back to the step label
	 * and then to "agent") would reject a wait that belongs to this row. */
	agentName?: string;
	/** Which pi session launched the run — control is session-scoped upstream. */
	sessionId?: string;
	/** What this row is, derived from the STEP and only then from the run. A
	 * row is a step, and the two disagree routinely: an intercom detach ends
	 * the run record as "failed" while its child keeps working, and one failed
	 * step of five leaves the run "complete". Every display and every gate
	 * reads this; `runState` is kept for the record, not for labels. */
	state: RowState;
	/** Run-level state as recorded ("running" | "complete" | "failed" | …). */
	runState: string;
	/** This step is running under a run record that has already ended — what an
	 * intercom detach leaves behind. The child outlives its run: still writing,
	 * still costing money, no longer owned by the run's own lifecycle. */
	detached: boolean;
	/** Upstream's own "this child is blocked on someone" flag. Only runner-
	 * hosted runs ever set it, so its absence proves nothing — the supervisor
	 * channel is the signal that works for parent-hosted runs. */
	needsAttention: boolean;
	/** Why this step ended the way it did, when it says. The step's own reason
	 * ("Subagent completed without making edits for an implementation task")
	 * answers the question a bare "failed" provokes; the run's reason is the
	 * fallback and is usually about the wrapper, not the child. First line
	 * only and bounded — a run-level error carries a whole stack trace. */
	error?: string;
	stepStatus: string;
	model?: string;
	thinking?: string;
	mode?: string;
	cwd?: string;
	startedAt?: number;
	lastUpdate?: number;
	lastActivityAt?: number;
	currentTool?: string;
	currentToolArgs?: string;
	turnCount?: number;
	toolCount?: number;
	sessionFile?: string;
	sessionFileExists: boolean;
	/** Run-level output log name (relative to dir), when recorded. */
	outputFile?: string;
	dir: string;
}

export const MAX_ROWS = 50;

/** A recorded "running" whose heartbeat stopped: the process that would have
 * finished the record died with its parent. The state cannot be trusted, only
 * reported as stale. */
export const STALE_RUNNING_MS = 120_000;

/** The freshest proof this STEP is alive. Step activity first: a run's
 * `lastUpdate` moves whenever any of its steps writes, so judging a step by it
 * lets a live sibling vouch for a dead one. Falling back the other way is
 * safe — a step that has not reported activity yet has only the run's clock.
 * The fallback is also taken when the step's own stamp is unbelievable, which
 * does re-admit sibling vouching for that one case: a stamp from the future is
 * no evidence at all, and the run's clock is worse evidence than the step's but
 * better than none.
 *
 * A stamp from the future gets two different treatments because it has two
 * different causes. Within tolerance it is clock skew between the writer and
 * this process, and the child really is that fresh — clamping to `now` is
 * right. Beyond it, the number is not a time this machine can believe, and the
 * honest reading is that there is NO beat, not the freshest possible one:
 * clamping alone turned the age from negative to zero, which is just as
 * unfalsifiable, and the row became immortal — never stale, never dropped,
 * re-probed every tick forever. */
const CLOCK_SKEW_TOLERANCE_MS = 5_000;

export function lastBeat(row: RunRow, now: number): number {
	// An unbelievable stamp means ask the next witness, not assume death.
	// Vetoing the first candidate outright let one bad number — or a backward
	// clock step, which makes EVERY recent stamp look future-dated at once —
	// mark live children stale in bulk, which also switches off the supervisor
	// probe (it skips stale rows) and offers to revive running children.
	for (const candidate of [row.lastActivityAt, row.lastUpdate, row.startedAt]) {
		if (candidate === undefined) continue;
		if (candidate > now + CLOCK_SKEW_TOLERANCE_MS) continue;
		return Math.min(candidate, now);
	}
	return 0;
}

export function isStale(row: RunRow, now: number): boolean {
	return row.state === "running" && now - lastBeat(row, now) > STALE_RUNNING_MS;
}

/** The temp scope the foreign extension namespaces its artifacts under,
 * mirroring upstream's `resolveTempScopeId` (shared/types.ts) TIER FOR TIER.
 * An "approximation" here is a different directory, and a different directory
 * is the whole extension silently inert: the earlier version skipped the
 * `user-` tier entirely, so on Windows — where `getuid` is undefined and
 * `USERNAME` is always set — upstream lands on `user-<name>` while the hub
 * landed on `home-<path>`, every scan returned empty, and nothing errored. */
function sanitizeTempScopeSegment(value: string): string {
	const sanitized = value.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
	return sanitized || "unknown";
}

function tempScopeId(): string {
	// Presence of the function, not its value: upstream keys on any uid the
	// platform reports, including one a `>= 0` guard would have rejected.
	if (typeof process.getuid === "function") return `uid-${process.getuid()}`;
	for (const key of ["USERNAME", "USER", "LOGNAME"] as const) {
		const value = process.env[key];
		if (value) return `user-${sanitizeTempScopeSegment(value)}`;
	}
	try {
		const username = os.userInfo().username;
		if (username) return `user-${sanitizeTempScopeSegment(username)}`;
	} catch {
		// Fall through to home-directory-based scoping.
	}
	const homedir = process.env.USERPROFILE ?? process.env.HOME;
	if (homedir) return `home-${sanitizeTempScopeSegment(homedir)}`;
	try {
		const fallback = os.homedir();
		if (fallback) return `home-${sanitizeTempScopeSegment(fallback)}`;
	} catch {
		// Fall through to the last-resort shared scope.
	}
	return "shared";
}

/** The foreign extension's temp root. Every artifact family it publishes —
 * run dirs, results, supervisor channels — hangs off this one directory. */
export function tempRoot(): string {
	return path.join(os.tmpdir(), `pi-subagents-${tempScopeId()}`);
}

export function asyncRunsRoot(): string {
	return path.join(tempRoot(), "async-subagent-runs");
}

interface CacheEntry {
	mtimeMs: number;
	rows: RunRow[];
}

/** Cache keyed on status.json path; entries reparse only when the file's mtime
 * moves. A live run touches its status constantly, so the cache converges to
 * reparsing exactly the runs that are changing. */
export type ScanCache = Map<string, CacheEntry>;

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Enough of a reason to be worth a row, never enough to be a cost. Upstream's
 * run-level errors arrive with a stack trace attached, so the first line is
 * the whole signal and the rest is noise measured in kilobytes. */
const MAX_ERROR_CHARS = 300;

function asReason(value: unknown): string | undefined {
	const text = asString(value);
	if (text === undefined) return undefined;
	const [first] = text.split("\n", 1);
	const line = (first ?? "").trim().replace(/^(?:Error:\s*)+/, "");
	if (!line) return undefined;
	if (line.length <= MAX_ERROR_CHARS) return line;
	// By code point, not code unit. A cut inside a surrogate pair renders one
	// column wider than `visibleWidth` reports — the sibling module's `clip`
	// carries this same rule, and slicing by units here reintroduced the exact
	// defect it was fixed for. A code point is at most two units, so the first
	// MAX points always live inside the first 2*MAX units.
	// One code point past the bound, so the slice can PROVE which case this is:
	// if the line had more than MAX points, its first MAX+1 occupy at most
	// 2*(MAX+1) units and are therefore all inside this slice. Sampling exactly
	// 2*MAX units instead cannot tell "exactly MAX points" from "far more", and
	// returning the original line in that branch let an all-emoji reason escape
	// the bound completely — 400 points rendered in full.
	const points = Array.from(line.slice(0, MAX_ERROR_CHARS * 2 + 2));
	// The ellipsis only when something was actually cut: saying the reason
	// continues when the reader is looking at all of it is its own small lie.
	if (points.length <= MAX_ERROR_CHARS) return line;
	return `${points.slice(0, MAX_ERROR_CHARS).join("")}…`;
}

function rowsFromStatus(dir: string, raw: unknown): RunRow[] {
	if (typeof raw !== "object" || raw === null) return [];
	const status = raw as Record<string, unknown>;
	const runId = asString(status.runId) ?? path.basename(dir);
	const steps = Array.isArray(status.steps) && status.steps.length > 0 ? status.steps : [{}];
	const rows: RunRow[] = [];
	const runState = asString(status.state) ?? "unknown";
	// `> 0`, not merely present: a zero or negative endedAt is not an ending,
	// and treating it as one marked a plainly running run detached.
	const runOver = RUN_OVER.has(normalizeState(runState) ?? "unknown") || (asNumber(status.endedAt) ?? 0) > 0;
	for (let index = 0; index < steps.length; index++) {
		const step = (typeof steps[index] === "object" && steps[index] !== null ? steps[index] : {}) as Record<string, unknown>;
		const sessionFile = asString(step.sessionFile);
		// Presence, not parseability: `asString` answers undefined for a number,
		// a null, an object AND the empty string, so judging absence by it let a
		// step that HAS a status — just not a readable one — borrow the run's
		// answer, which is the exact substitution the comment below forbids.
		// A JSON null counts as present: upstream's type makes `status` required
		// and non-null, so a null there is a writer that emitted something which
		// is not a status — malformed, not absent, and malformed must not
		// inherit the run's answer.
		const hasStatus = step.status !== undefined;
		const rawStatus = asString(step.status);
		const stepStatus = rawStatus ?? "unknown";
		// The step's own word, and only if it has NO word does the run speak
		// for it: a status.json written before any step exists carries the
		// run's state alone, and that is the one case where it is also the
		// step's. A step status this version does not know stays unknown —
		// borrowing the run's answer there is how a row comes to claim a state
		// nothing measured.
		const state = hasStatus
			? normalizeState(rawStatus) ?? "unknown"
			: normalizeState(runState) ?? "unknown";
		rows.push({
			runId,
			stepIndex: index,
			stepCount: steps.length,
			agent: asString(step.agent) ?? asString(step.label) ?? "agent",
			agentName: asString(step.agent),
			sessionId: asString(status.sessionId),
			state,
			runState,
			detached: state === "running" && runOver,
			needsAttention: asString(step.activityState) === "needs_attention",
			// The run's reason speaks for a step ONLY when there is one step to
			// speak for. Falling back for every step printed the wrapper's
			// "Detached for intercom coordination" under all four healthy
			// siblings of the one that failed — the same misattribution this
			// whole changeset exists to end, one level down.
			error: asReason(step.error) ?? (steps.length === 1 ? asReason(status.error) : undefined),
			stepStatus,
			model: asString(step.model),
			thinking: asString(step.thinking),
			mode: asString(status.mode),
			cwd: asString(status.cwd),
			startedAt: asNumber(step.startedAt) ?? asNumber(status.startedAt),
			lastUpdate: asNumber(status.lastUpdate),
			lastActivityAt: asNumber(step.lastActivityAt),
			currentTool: asString(step.currentTool),
			currentToolArgs: asString(step.currentToolArgs),
			turnCount: asNumber(step.turnCount),
			toolCount: asNumber(step.toolCount),
			sessionFile,
			sessionFileExists: sessionFile !== undefined && fs.existsSync(sessionFile),
			outputFile: asString(status.outputFile),
			dir,
		});
	}
	return rows;
}

/** Scan the runs root into list rows: parseable statuses only, most recent
 * first. A row survives the residue filter when its session file still
 * exists (the runs worth reading) or it claims to be running and its heartbeat
 * is fresh (the runs worth watching). Test residue — hundreds of dirs on a
 * machine that has run the foreign extension's suite — fails both. */
export function scanRuns(root: string, cache: ScanCache, now = Date.now()): RunRow[] {
	let names: string[];
	try {
		names = fs.readdirSync(root);
	} catch {
		return [];
	}
	const all: RunRow[] = [];
	const seen = new Set<string>();
	for (const name of names) {
		const dir = path.join(root, name);
		const statusPath = path.join(dir, "status.json");
		let stat: fs.Stats;
		try {
			stat = fs.statSync(statusPath);
		} catch {
			continue;
		}
		seen.add(statusPath);
		const cached = cache.get(statusPath);
		if (cached && cached.mtimeMs === stat.mtimeMs) {
			all.push(...cached.rows);
			continue;
		}
		let rows: RunRow[] = [];
		try {
			rows = rowsFromStatus(dir, JSON.parse(fs.readFileSync(statusPath, "utf8")));
		} catch {
			// Unparseable status: not a run this can show. Cache the verdict so a
			// broken file is not re-read every tick.
		}
		cache.set(statusPath, { mtimeMs: stat.mtimeMs, rows });
		all.push(...rows);
	}
	for (const key of cache.keys()) if (!seen.has(key)) cache.delete(key);

	// Judged by the same clock `isStale` uses. While this read the run's
	// `lastUpdate` and staleness read the step's, a row this module's own rule
	// called fresh could be dropped from the scan entirely — no label, glyph or
	// counter downstream can rescue a row that never arrives.
	const kept = all.filter(row => row.sessionFileExists || (row.state === "running" && now - lastBeat(row, now) < STALE_RUNNING_MS));
	// Ranked by the same clock the filter and staleness use. Ranking by the
	// RUN's `lastUpdate` while judging freshness by the step's put the one row
	// this list exists to surface — a detached child still writing under a run
	// record that stopped moving 40 minutes ago — behind every finished run,
	// and the caller's MAX_ROWS cut it off the list entirely.
	kept.sort((a, b) => lastBeat(b, now) - lastBeat(a, now));
	// Uncapped: the display bound belongs to the caller, after its scope
	// filter — capping here let newer runs from other projects push a
	// project's own runs out of the project view.
	return kept;
}

/** Unique by construction: two runs cannot share a directory, where two could
 * in principle share a recorded runId. A collision made the list unnavigable,
 * since every lookup resolved to the first of the pair. */
export function rowKey(row: RunRow): string {
	return `${row.dir}:${row.stepIndex}`;
}

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
	/** Recorded `status.startedAt`, used for stable roster ordering. It is kept
	 * separate from the step's `startedAt`: later steps must not reorder a run,
	 * and a malformed/missing run timestamp must not borrow activity time. */
	createdAt?: number;
	/** Start time of this particular step, used for its elapsed label and
	 * heartbeat fallback. */
	startedAt?: number;
	lastUpdate?: number;
	lastActivityAt?: number;
	currentTool?: string;
	currentToolArgs?: string;
	/** When the in-flight tool call started. The honest clock for a blocking
	 * ask: the heartbeat is neither bound on one — measured on real records it
	 * both freezes at ask start AND advances mid-ask (276s, once), so dating an
	 * ask by activity either robs it of its window or grants it one it never
	 * had. Present only while a tool IS in flight, which is exactly when the
	 * question is asked. */
	currentToolStartedAt?: number;
	turnCount?: number;
	toolCount?: number;
	sessionFile?: string;
	sessionFileExists: boolean;
	/** Run-level output log name (relative to dir), when recorded. */
	outputFile?: string;
	/** The workflow shell that owns this child, when this is a workflow child.
	 * A resumed child is written under a fresh workflow run, so this relation is
	 * the only identity available while the shell's own step has no sessionFile. */
	parentWorkflowRunId?: string;
	/** Outer workflow relation key: parsed from `status.workflowKey` when
	 * `parentWorkflowRunId` is present. */
	parentWorkflowKey?: string;
	/** Inner workflow relation key: parsed from `step.workflowKey` or
	 * `status.workflowKey` for non-nested workflow runs. */
	stepWorkflowKey?: string;
	/** Unified/fallback workflow lane key. */
	workflowKey?: string;
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

/** Timestamps must be strictly positive finite numbers. Negative or zero
 * foreign values are hostile/malformed and normalized to undefined (neutral). */
function asTimestamp(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Counters must be non-negative finite numbers. */
function asCount(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : undefined;
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
			// speak for AND that step's own verdict agrees something went wrong.
			// Falling back for every step printed the wrapper's "Detached for
			// intercom coordination" under all four healthy siblings of the one
			// that failed — and borrowing it under a ✓ told the reader a
			// completed child had failed, when the detach was the wrapper's
			// story and the child finished fine.
			error: asReason(step.error)
				?? (steps.length === 1 && (state === "failed" || state === "stopped" || state === "rejected") ? asReason(status.error) : undefined),
			stepStatus,
			model: asString(step.model),
			thinking: asString(step.thinking),
			mode: asString(status.mode),
			cwd: asString(status.cwd),
			createdAt: asTimestamp(status.startedAt),
			startedAt: asTimestamp(step.startedAt) ?? asTimestamp(status.startedAt),
			lastUpdate: asTimestamp(status.lastUpdate),
			lastActivityAt: asTimestamp(step.lastActivityAt),
			currentTool: asString(step.currentTool),
			currentToolArgs: asString(step.currentToolArgs),
			currentToolStartedAt: asTimestamp(step.currentToolStartedAt),
			turnCount: asCount(step.turnCount),
			toolCount: asCount(step.toolCount),
			sessionFile,
			sessionFileExists: sessionFile !== undefined && fs.existsSync(sessionFile),
			outputFile: asString(status.outputFile),
			parentWorkflowRunId: asString(status.parentWorkflowRunId),
			parentWorkflowKey: asString(status.parentWorkflowRunId) !== undefined ? asString(status.workflowKey) : undefined,
			stepWorkflowKey: asString(step.workflowKey) ?? (asString(status.parentWorkflowRunId) === undefined ? asString(status.workflowKey) : undefined),
			workflowKey: asString(step.workflowKey) ?? asString(status.workflowKey),
			dir,
		});
	}
	return rows;
}

/** A workflow shell and its child are two status files, but one conversation.
 * The child carries `parentWorkflowRunId`/`workflowKey`; the shell carries the
 * same lane key on its step. Resumed workflow shells sometimes lose the
 * step's sessionFile, so link the pair before the residue filter and borrow a
 * session path only when the relation names exactly one path. A nested shell
 * participates in both its parent relation and its own child relation. A
 * conflicting component stays separate rather than guessing which conversation
 * it is. */
function linkWorkflowSessionFiles(rows: RunRow[]): RunRow[] {
	const linked = [...rows];
	const keysFor = (row: RunRow): string[] => {
		// Workflow keys are model/user-chosen foreign strings. JSON keeps a colon
		// or other separator in one tuple field instead of colliding two lanes.
		const keys: string[] = [];
		const outerKey = row.parentWorkflowKey ?? row.workflowKey;
		if (row.parentWorkflowRunId !== undefined && outerKey !== undefined) {
			keys.push(JSON.stringify([row.parentWorkflowRunId, outerKey]));
		}
		// A nested workflow is both a child and a shell. It must also expose its
		// own relation, or its inner child cannot connect through it to the outer
		// shell. The same key intentionally joins a shell's runId to its child's
		// parentWorkflowRunId.
		if (row.mode === "workflow" && row.stepWorkflowKey !== undefined) {
			keys.push(JSON.stringify([row.runId, row.stepWorkflowKey]));
		}
		return keys;
	};
	// Build connected identity components in one bounded pass. Repeating a
	// per-key copy could let a conflicting path leak through an intermediate
	// nested shell; union first, then make the all-or-nothing path decision for
	// the whole component.
	const parent = rows.map((_, index) => index);
	const find = (index: number): number => {
		let root = index;
		while (parent[root] !== root) root = parent[root]!;
		while (parent[index] !== index) {
			const next = parent[index]!;
			parent[index] = root;
			index = next;
		}
		return root;
	};
	const union = (left: number, right: number): void => {
		const leftRoot = find(left);
		const rightRoot = find(right);
		if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
	};
	const firstByKey = new Map<string, number>();
	for (let index = 0; index < linked.length; index++) {
		for (const key of keysFor(linked[index]!)) {
			const first = firstByKey.get(key);
			if (first === undefined) firstByKey.set(key, index);
			else union(first, index);
		}
	}
	const components = new Map<number, number[]>();
	for (let index = 0; index < linked.length; index++) {
		const root = find(index);
		const component = components.get(root);
		if (component) component.push(index);
		else components.set(root, [index]);
	}
	for (const component of components.values()) {
		const files = new Set<string>();
		for (const index of component) {
			const sessionFile = linked[index]!.sessionFile;
			if (sessionFile !== undefined) files.add(sessionFile);
		}
		if (files.size !== 1) continue;
		const sessionFile = files.values().next().value!;
		for (const index of component) {
			const row = linked[index]!;
			if (row.sessionFile !== undefined) continue;
			linked[index] = { ...row, sessionFile, sessionFileExists: fs.existsSync(sessionFile) };
		}
	}
	return linked;
}

export interface ScanResult {
	/** Residue-filtered, deduplicated conversation rows sorted newest first. */
	kept: RunRow[];
	/** All pre-residue linked run graph rows, preserving workflow shells. */
	linked: RunRow[];
}

/** Scan the runs root into list rows: parseable statuses only, most recent
 * first. A row survives the residue filter when its session file still
 * exists (the runs worth reading) or it claims to be running and its heartbeat
 * is fresh (the runs worth watching). Test residue — hundreds of dirs on a
 * machine that has run the foreign extension's suite — fails both. */
export function scanRuns(root: string, cache: ScanCache, now = Date.now()): ScanResult {
	let names: string[];
	try {
		names = fs.readdirSync(root);
	} catch {
		return { kept: [], linked: [] };
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
			// `status.json` mtime does not move when the independently written
			// session file appears or disappears. Refresh this foreign-file fact on
			// every tick instead of freezing the initial cache verdict.
			all.push(...cached.rows.map(row => row.sessionFile === undefined
				? row
				: { ...row, sessionFileExists: fs.existsSync(row.sessionFile) }));
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

	// A resumed workflow can publish its shell before the child status has a
	// session path of its own. Link those records before judging residue, or the
	// shell briefly appears as a second live agent and then disappears when it
	// completes — exactly the flicker the roster must not show.
	const linked = linkWorkflowSessionFiles(all);
	// Judged by the same clock `isStale` uses. While this read the run's
	// `lastUpdate` and staleness read the step's, a row this module's own rule
	// called fresh could be dropped from the scan entirely — no label, glyph or
	// counter downstream can rescue a row that never arrives.
	const kept = linked.filter(row => row.sessionFileExists || (row.state === "running" && now - lastBeat(row, now) < STALE_RUNNING_MS));
	// Stable roster order is creation order, newest first. Sorting by lastBeat
	// made a row jump every time a different child emitted output, which turned
	// a multi-agent list into a moving target and changed the meaning of j/k.
	// Conversation merging in the hub applies the same creation-time rule to
	// the whole group, so selecting a different record cannot restore activity
	// ordering.
	kept.sort(compareRunRows);
	// Uncapped: the display bound belongs to the caller, after its scope
	// filter — capping here let newer runs from other projects push a
	// project's own runs out of the project view.
	return { kept, linked };
}

/** Unique by construction: two runs cannot share a directory, where two could
 * in principle share a recorded runId. A collision made the list unnavigable,
 * since every lookup resolved to the first of the pair. */
export function rowKey(row: RunRow): string {
	return `${row.dir}:${row.stepIndex}`;
}

/** Newest recorded run creation first, with a deterministic identity tie-break.
 * Activity is intentionally absent: output from one child must not move it past
 * another child, and a later step must not move a sequential run. Missing or
 * malformed `status.startedAt` is neutral rather than borrowing a step clock. */
export function compareRunRows(left: RunRow, right: RunRow): number {
	const byCreation = (right.createdAt ?? 0) - (left.createdAt ?? 0);
	if (byCreation !== 0) return byCreation;
	const leftKey = rowKey(left);
	const rightKey = rowKey(right);
	return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

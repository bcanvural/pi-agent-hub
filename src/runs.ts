// Where runs are found and what a row in the hub's list is.
//
// The list is driven from disk — each run's status.json carries everything a
// row needs (runId, per-step sessionFile, current tool, activity stamps) where
// the RPC's fleet entries carry none of it. The RPC supplements liveness; this
// module supplies identity.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** One selectable row: a single step of an async run. */
export interface RunRow {
	runId: string;
	stepIndex: number;
	stepCount: number;
	agent: string;
	/** Which pi session launched the run — control is session-scoped upstream. */
	sessionId?: string;
	/** Run-level state as recorded ("running" | "complete" | "failed" | …). */
	state: string;
	stepStatus: string;
	model?: string;
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

export function isStale(row: RunRow, now: number): boolean {
	return row.state === "running" && now - (row.lastUpdate ?? 0) > STALE_RUNNING_MS;
}

/** The temp scope the foreign extension namespaces its artifacts under —
 * uid-keyed on anything POSIX, mirroring its own resolution. The home fallback
 * approximates the original's sanitizer; on this platform the uid branch is
 * the one that runs. */
function tempScopeId(): string {
	const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
	if (uid !== undefined && uid >= 0) return `uid-${uid}`;
	try {
		const home = os.homedir();
		if (home) return `home-${home.replace(/[^a-zA-Z0-9._-]+/g, "-")}`;
	} catch {
		// Fall through to the shared scope.
	}
	return "shared";
}

export function asyncRunsRoot(): string {
	return path.join(os.tmpdir(), `pi-subagents-${tempScopeId()}`, "async-subagent-runs");
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

function rowsFromStatus(dir: string, raw: unknown): RunRow[] {
	if (typeof raw !== "object" || raw === null) return [];
	const status = raw as Record<string, unknown>;
	const runId = asString(status.runId) ?? path.basename(dir);
	const steps = Array.isArray(status.steps) && status.steps.length > 0 ? status.steps : [{}];
	const rows: RunRow[] = [];
	for (let index = 0; index < steps.length; index++) {
		const step = (typeof steps[index] === "object" && steps[index] !== null ? steps[index] : {}) as Record<string, unknown>;
		const sessionFile = asString(step.sessionFile);
		rows.push({
			runId,
			stepIndex: index,
			stepCount: steps.length,
			agent: asString(step.agent) ?? asString(step.label) ?? "agent",
			sessionId: asString(status.sessionId),
			state: asString(status.state) ?? "unknown",
			stepStatus: asString(step.status) ?? "unknown",
			model: asString(step.model),
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
 * first, capped. A row survives the residue filter when its session file still
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

	const kept = all.filter(row => row.sessionFileExists || (row.state === "running" && now - (row.lastUpdate ?? 0) < STALE_RUNNING_MS));
	kept.sort((a, b) => (b.lastUpdate ?? b.startedAt ?? 0) - (a.lastUpdate ?? a.startedAt ?? 0));
	return kept.slice(0, MAX_ROWS);
}

/** Unique by construction: two runs cannot share a directory, where two could
 * in principle share a recorded runId. A collision made the list unnavigable,
 * since every lookup resolved to the first of the pair. */
export function rowKey(row: RunRow): string {
	return `${row.dir}:${row.stepIndex}`;
}

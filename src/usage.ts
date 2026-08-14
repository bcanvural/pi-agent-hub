// Cost and token totals for a run, summed from the `usage` objects pi writes
// into every assistant record of the child's session file — pre-priced per
// model by pi itself, so no pricing tables live here.
//
// Usage is scattered through the whole file, so the first fill must read all
// of it. That read is BUDGETED: a meter advances at most `budget` bytes per
// call, and the hub advances one meter per poll tick — a cold open over a
// roster of multi-megabyte sessions fills in over a few seconds instead of
// stalling pi's event loop, which is the same loop serving the user's own
// conversation. Completed runs converge and never read again; running runs
// consume only what was appended.
import * as fs from "node:fs";

/** The worst tick is NOT set by this number: it is the completion tick of a
 * single multi-megabyte line (~50ms parse on a 50MB pathological session),
 * which no budget can split. The budget only paces the read; shrinking it
 * measurably worsened total fill time, so it stays at a size that keeps
 * ordinary ticks in the low single-digit milliseconds. */
const DEFAULT_BUDGET_BYTES = 512 * 1024;
/** Same rewrite detection as the transcript tail: the last consumed bytes are
 * re-read before consuming more, because an in-place rewrite keeps the inode
 * and can come back larger — and a meter that misses it double-counts. */
const ANCHOR_BYTES = 64;
/** A single line is buffered at most this far; past it the line is discarded
 * to the next newline. Real usage-bearing records are kilobytes — this cap
 * exists because the alternative is unbounded memory and, past V8's string
 * ceiling (~537MB), a decode that THROWS out of the poll timer and takes the
 * whole session down (invariant 1). A >32MB record forfeits any money it
 * carried; the meter stays alive. */
const MAX_LINE_BYTES = 32 * 1024 * 1024;

interface UsageShape {
	totalTokens?: unknown;
	cost?: { total?: unknown };
}

export interface UsageTotals {
	cost: number;
	tokens: number;
	/** Assistant turns that carried usage — a proxy for billed requests. */
	requests: number;
}

export class UsageMeter {
	readonly filePath: string;
	readonly totals: UsageTotals = { cost: 0, tokens: 0, requests: 0 };
	/** Caught up with the file as of the last advance. */
	done = false;
	fileMissing = false;
	private offset = 0;
	private leftover: Buffer[] = [];
	private leftoverBytes = 0;
	private discarding = false;
	private anchor: Buffer = Buffer.alloc(0);
	private identity = "";
	private started = false;
	private readonly maxLineBytes: number;

	constructor(filePath: string, maxLineBytes = MAX_LINE_BYTES) {
		this.filePath = filePath;
		this.maxLineBytes = maxLineBytes;
	}

	private reset(): void {
		this.totals.cost = 0;
		this.totals.tokens = 0;
		this.totals.requests = 0;
		this.offset = 0;
		this.leftover = [];
		this.leftoverBytes = 0;
		this.discarding = false;
		this.anchor = Buffer.alloc(0);
		this.done = false;
	}

	private anchorHolds(): boolean {
		if (this.anchor.length === 0 || this.offset < this.anchor.length) return true;
		let fd: number;
		try {
			fd = fs.openSync(this.filePath, "r");
		} catch {
			return true;
		}
		try {
			const seen = Buffer.alloc(this.anchor.length);
			const read = fs.readSync(fd, seen, 0, seen.length, this.offset - this.anchor.length);
			return read === seen.length && seen.equals(this.anchor);
		} catch {
			return true;
		} finally {
			fs.closeSync(fd);
		}
	}

	/** Consume up to `budget` bytes. True when the totals changed or the
	 * done/missing state flipped — the caller's cue to repaint. */
	advance(budget = DEFAULT_BUDGET_BYTES): boolean {
		let stat: fs.Stats;
		try {
			stat = fs.statSync(this.filePath);
		} catch {
			const flipped = !this.fileMissing;
			this.fileMissing = true;
			this.done = true;
			return flipped;
		}
		const reappeared = this.fileMissing;
		this.fileMissing = false;

		const identity = `${stat.ino}:${stat.dev}:${Math.trunc(stat.birthtimeMs)}`;
		if (this.started && (identity !== this.identity || stat.size < this.offset || !this.anchorHolds())) {
			this.reset();
		}
		this.identity = identity;
		this.started = true;

		if (stat.size === this.offset) {
			const flipped = !this.done || reappeared;
			this.done = true;
			return flipped;
		}
		this.done = false;

		let fd: number;
		try {
			fd = fs.openSync(this.filePath, "r");
		} catch {
			return reappeared;
		}
		let chunk: Buffer;
		try {
			const want = Math.min(budget, stat.size - this.offset);
			const buffer = Buffer.alloc(want);
			const read = fs.readSync(fd, buffer, 0, buffer.length, this.offset);
			chunk = read === buffer.length ? buffer : buffer.subarray(0, Math.max(0, read));
			this.offset += chunk.length;
		} catch {
			return reappeared;
		} finally {
			fs.closeSync(fd);
		}
		if (chunk.length === 0) return reappeared;
		this.anchor = chunk.length >= ANCHOR_BYTES
			? Buffer.from(chunk.subarray(-ANCHOR_BYTES))
			: Buffer.from(Buffer.concat([this.anchor, chunk]).subarray(-ANCHOR_BYTES));

		// A line that blew the cap is skipped to its terminating newline; the
		// bytes after it are ordinary data again.
		let body = chunk;
		if (this.discarding) {
			const endOfLine = body.indexOf(0x0a);
			if (endOfLine === -1) return reappeared;
			body = body.subarray(endOfLine + 1);
			this.discarding = false;
			if (body.length === 0) return reappeared;
		}

		// The partial line is kept as a LIST of chunks: a line larger than the
		// budget then costs one copy per tick, where a single growing buffer
		// re-copied everything seen so far every tick — quadratic across a
		// multi-megabyte line, and measurably the dominant fill cost.
		const newlineAt = body.lastIndexOf(0x0a);
		if (newlineAt === -1) {
			this.leftover.push(Buffer.from(body));
			this.leftoverBytes += body.length;
			if (this.leftoverBytes > this.maxLineBytes) {
				this.leftover = [];
				this.leftoverBytes = 0;
				this.discarding = true;
			}
			return reappeared;
		}
		const complete = body.subarray(0, newlineAt);
		const data = this.leftover.length > 0 ? Buffer.concat([...this.leftover, complete]) : complete;
		this.leftover = newlineAt + 1 < body.length ? [Buffer.from(body.subarray(newlineAt + 1))] : [];
		this.leftoverBytes = this.leftover.length > 0 ? this.leftover[0]!.length : 0;

		let changed = reappeared;
		let text: string;
		try {
			text = data.toString("utf8");
		} catch {
			// Beyond V8's string ceiling the line cannot even be examined. The
			// cap above makes this unreachable; if it is reached anyway, skip
			// the data rather than let a throw out of a timer end the session.
			text = "";
		}
		for (const line of text.split("\n")) {
			// Cheap prefilter: parsing every multi-kilobyte tool-result line
			// for nothing is most of the cost of reading a big session.
			if (!line.includes('"usage"')) continue;
			try {
				const record = JSON.parse(line) as {
					type?: string;
					usage?: UsageShape;
					message?: { role?: string; usage?: UsageShape };
				};
				// Pi books usage in three record shapes (its getUsageCostBreakdown
				// rule, mirrored here exactly): assistant and toolResult messages
				// carry it under `message`; compaction and branch-summary records
				// carry it at the TOP level — a full-context call, exactly the
				// spend a long-running child incurs. Reading only `message.usage`
				// silently dropped up to 4.7% of real sessions' money.
				const usage = record.type === "message"
					? (record.message?.role === "assistant" || record.message?.role === "toolResult"
						? record.message.usage
						: undefined)
					: (record.type === "compaction" || record.type === "branch_summary"
						? record.usage
						: undefined);
				if (!usage) continue;
				const cost = usage.cost?.total;
				const tokens = usage.totalTokens;
				// Foreign numbers get the same suspicion as foreign strings —
				// including absurd magnitude: 1e308 passes a finiteness check
				// and one addition later every aggregate is Infinity.
				if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0 && cost < 1e6) this.totals.cost += cost;
				if (typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0 && tokens < 1e12) this.totals.tokens += tokens;
				this.totals.requests += 1;
				changed = true;
			} catch {
				// Mid-write or malformed line; the transcript pane already
				// tolerates these, the meter simply skips them.
			}
		}
		if (this.offset === stat.size) {
			this.done = true;
			changed = true;
		}
		return changed;
	}
}

/** omp-style money: `$0.088`, `$1.24`, `$12.4`. */
export function formatCost(cost: number): string {
	if (cost <= 0) return "$0";
	if (cost < 0.1) return `$${cost.toFixed(3)}`;
	if (cost < 10) return `$${cost.toFixed(2)}`;
	return `$${cost.toFixed(1)}`;
}

export function formatTokens(tokens: number): string {
	if (tokens < 1000) return `${tokens}`;
	if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}K`;
	return `${(tokens / 1_000_000).toFixed(1)}M`;
}

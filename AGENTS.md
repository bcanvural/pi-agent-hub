# Working in pi-agent-hub

A [pi](https://github.com/earendil-works/pi) extension: `/hub` opens a floating
panel that lists the background agents [pi-subagents](https://github.com/nicobailon/pi-subagents)
runs, tails the selected child's **pi session file**, renders it through pi's
own message components, and talks back — steer, resume, interrupt, stop.

`DESIGN.md` is the source of truth for everything environmental: the run
topology, the RPC protocol, session-scoped ownership, revival runs, why session
files (not transcript artifacts) are the record. Those facts were established
by probing the installed extension live, not by reading its docs — re-verify
against the installed version before assuming they still hold, and update
DESIGN.md when they move.

## Commands

```
npm run typecheck        # tsc --noEmit — the only build gate; keep it clean
```

There is no test suite. Verification here is standalone execution:

```
node --input-type=module -e "
const pi = await import('./node_modules/@earendil-works/pi-coding-agent/dist/index.js');
pi.initTheme('dark');                       // components throw without a theme
const { SessionTail } = await import('./src/session-view.ts');
..."
```

Every module must stay runnable this way — **no constructor parameter
properties** (`constructor(private x: T)`); `--experimental-strip-types`
refuses the syntax and every harness in this repo's history drives modules
standalone. For UI checks, drive a real pi in tmux (`pi install <repo> -l` in
a scratch dir, `/hub`, `tmux capture-pane`); the smoke pattern is in the git
history.

## Hard invariants (each earned by a shipped bug)

1. **Never crash the host.** This code runs inside the user's live pi session.
   A throw out of `render`/`handleInput`/timer callbacks — or an unhandled
   subprocess `'error'` event — reaches pi's `uncaughtException` handler,
   which calls `process.exit(1)` and destroys the user's session. Foreign
   components render behind a catch; every `spawn` gets an `'error'` listener.
2. **Width discipline is load-bearing.** pi throws on any rendered row wider
   than the terminal. Every composed row goes through `truncateToWidth`;
   slicing is code-point-aware (a lone surrogate renders one column wider than
   `visibleWidth` reports).
3. **Sanitize every foreign string at its render site.** Agent names, models,
   tool names, cwd, bridge reply text — all come from another extension's
   `status.json`, often from model-chosen names. A control byte there clears
   the user's screen. `sanitizeLine` (output-tail.ts) is the one treatment.
4. **Writes are confined to four surfaces**: RPC envelopes on pi's event bus,
   a run's own `control/` inbox (fallback only, atomic tmp+rename, upstream's
   20-entry queue bound honoured), user-invoked subprocesses, and the hub's
   own settings file (`~/.pi/agent/pi-agent-hub.json`, atomic tmp+rename).
   Session files and status.json are never written. v0 was fully read-only;
   keep the boundary explicit in any new write.
5. **Cost tracks the viewport, not the session.** Sessions reach 7MB+; render
   only the window (`buildChatWindow` walks newest-first and stops), cache per
   record, never cache a record whose tool calls lack results (it would freeze
   as permanently pending). Rebuilding everything blocked pi's event loop for
   1.2s per child message once.
6. **Honest labels.** The action row must say what actually happened —
   delivered vs queued vs parked vs view-only — and a notice about run A must
   never display under run B. When state can't be known, say unknown; never
   interpolate a recorded "running" the heartbeat contradicts (stale runs).
7. **Files someone else writes are hostile at every boundary**: partial lines
   (keep remainders as *bytes*, copied — a `subarray` view pins the whole
   read), in-place rewrites that keep inode AND size growth (the 64-byte
   content anchor catches those), short reads, vanished files.
8. **Money follows pi's accounting rule, not a plausible one.** Usage lives in
   three record shapes (`getUsageCostBreakdown` in pi's `core/usage-totals`):
   assistant and toolResult messages under `message.usage`, compaction and
   branch-summary records at the top level. Reading only `message.usage`
   silently dropped up to 4.7% of real sessions' spend — and a ground-truth
   check written from the same wrong rule agreed with the bug by construction.
   Verify against pi's own function, never against a hand-rolled sum.
9. **A converged meter is not a finished one.** A running child's file grows
   again after every `done`; anything cached per file needs a scheduled
   re-look (the rotating candidate in `advanceUsage`), or every row but the
   selected one freezes at first read and presents that number as settled.

## Layout

| file | job |
|---|---|
| `src/index.ts` | extension entry: registers `/hub`, mounts the overlay |
| `src/hub.ts` | the panel: list, chat pane, composer, modes, actions, notices |
| `src/session-view.ts` | SessionTail (incremental JSONL reader) + windowed rendering through pi's components |
| `src/runs.ts` | run discovery: filtered scan of the artifact root, one row per step |
| `src/rpc.ts` | client for pi-subagents' `subagents:rpc:v1:*` bridge |
| `src/control-files.ts` | capability/ack readers + fallback inbox writers |
| `src/output-tail.ts` | bounded sanitized tail of a run's output log; exports `sanitizeLine` |
| `src/settings.ts` | the hub's own settings file (panel size): defensive read, atomic write |

## Conventions

- Tabs; comments state constraints and consequences ("why this must hold"),
  never narrate the next line. Commit messages explain the defect's failure
  mode, not the diff.
- Substantial changes go through an adversarial review round before being
  called done: an agent instructed to *execute* attacks (not read-and-approve),
  then a back-and-forth where its findings are independently verified before
  fixing, and the fixes attacked again. Every fix round so far has contained
  a defect of its own; plan for that.
- Testing against real artifacts (`$TMPDIR/pi-subagents-uid-*/`,
  `~/.pi/agent/sessions/`) is read-only, always. Anything that mutates gets a
  synthetic fixture. Live children for end-to-end checks are spawned in a
  scratch project and cost real tokens — keep tasks trivial.
- pi swallows Tab before overlays see it; overlay keybindings avoid it.
- `handleEditingInput` (hub.ts) is the changeset's proven regression magnet:
  four review rounds each found their new defect inside this one function.
  It now carries a sequence carry, a bound, and a budgeted discard state with
  explicit invariants — if you touch it, extend the state machine; do not add
  a fifth conditional.

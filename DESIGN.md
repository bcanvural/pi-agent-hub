# pi-agent-hub — design

A floating hub inside pi for watching and steering the background agents another
extension runs: a live list of runs, a full-fidelity chat view of any child, a
composer that types into a *running* child, and a way back to the main
conversation that is always one keypress. The model is omp's agent hub; the
mechanism is entirely different, because pi has no session-focus machinery to
borrow — this is built on files.

## Why it can exist at all

Two facts, both verified **live** on this machine against the installed
`pi-subagents` (0.46.0), carry the whole design:

1. **There is a versioned RPC for exactly this.** `pi-subagents` registers a
   bridge on `pi.events` — pi's cross-extension event bus — speaking
   `subagents:rpc:v1:*`: a `ready` handshake carrying a capability manifest,
   then `ping / status / spawn / steer / interrupt / stop / resume`, with a
   `source.extension` identity field in the envelope. Proven end to end from a
   scratch foreign extension: `ping` answered, `status` returned a structured
   fleet object (agent, model, tokens, goal, startedAt per entry), and `steer`
   against a live child returned `queued` with a request id and per-target
   state. This is a deliberate, versioned integration surface — the hub is the
   audience it exists for.

2. **Children write real pi session files, and those are the only complete
   record.** Every real run's `status.json` records a `sessionFile` under
   `~/.pi/agent/sessions/…` — permanent storage, surviving completion (measured:
   100 KB–7 MB, 12/12 present for real runs; confirmed growing live during a
   probe run, session-format `version: 3`). The structured `transcriptPath`
   artifact, which the stock fleet inspector renders from, was `null` on **every
   real run** on this machine — it exists only in that extension's test fixtures
   here. Reading session files is not the premium option; it is the only one
   that has data.

A session file is the full record: real message objects with `toolResult.details`
(edit diffs), thinking blocks, model names, timestamps. The transcript artifact —
when it exists at all — is a lossy monitoring feed that drops `details` at the
writer (verified upstream; see nicobailon/pi-subagents#1019).

### Run topology (0.46.0, established by killing things)

- **Every fresh child is hosted by the launching pi process** — a separate pi
  *child process*, but with no steer env, no `control/` watcher, and no runner.
  "Detached" in the spawn reply is terminology: SIGHUP/pty-kill of the parent
  killed the child every time, stranding `status.json` at `running` forever.
  Some runs never even get a run dir (RPC `status` reported a tracked job with
  no directory anywhere).
- **The detached `subagent-runner` process exists only for revived runs.**
  `resume` of a persisted run spawns it — that is where the `control/` inbox,
  the steer env, capability files and `runner.*.log` come from (all four real
  runs with runner artifacts here carry `recovery-descriptor.json`).
- **A steer against a live attached run parks.** RPC `steer` answered `queued`
  and wrote the file inbox — which nothing watches until a runner exists. The
  run completed with the request still sitting there, undelivered. `steer` with
  recovery (the tool path) can *revive* a run to deliver; the RPC sets
  `steeringRecovery: false`.
- 0.47 adds a close-grace mechanism (absent from 0.46 source), so this topology
  will shift — one more reason everything gates on the `ready` manifest's
  capabilities rather than assumptions.

### What this means for typing

Typing is real, but its semantics are per run state, and the composer must say
which one it got:

| run state | channel | delivery |
|---|---|---|
| running, attached | RPC `steer` | **parked** — delivers on resume; label it, never pretend it's live |
| running, revived runner (capability `supported: true`) | file inbox / RPC | **live** — injected between turns, acked in `steer-acks/` |
| stranded `running` (stale `lastUpdate`, parent gone) | RPC `resume` | revive with the message |
| complete / failed | RPC `resume` {id, message} | **conversation** — the child comes back, answers, session file grows |

That last row quietly replaces the v2 `switchSession` idea: `resume` with a
message *is* "type to a finished agent and read its answer", first-class and
upstream-supported, rendered live in our own chat pane as the session file
grows. No session swapping, no two-writer risk.

RPC-first stands: it reaches attached, revived, and dir-less runs alike and
routes each itself. Files demote to run discovery when RPC is absent and inbox
writes for orphaned runners. The hub is a cockpit; `pi-subagents` stays the
driver.

## What the ceiling still is

True focus — the child's chat *becoming* the main view, editor history and all —
needs `SessionFocusController`/`AgentRegistry`, which exist only in the omp fork
of pi core. `switchSession()` is a destructive replace, not a view. This project
does not attempt it. The overlay is a viewer with a composer, which covers the
actual want: observe, type, return.

## Shape

```
╭─ agents ──────────╮╭─ reviewer · running · 34s ──────────────╮
│ ● reviewer  34s   ││  ✓ read src/index.ts                     │
│ ● scout      8s   ││  ◆ The bug is in `clipPlain` — it        │
│ ✓ planner  2m     ││    returns its ellipsis even when…       │
│ ✗ oracle   12m    ││  ✓ edit src/render.ts  ⟨+4/-1⟩           │
╰───────────────────╯╰──────────────────────────────────────────╯
 steer › also check the width-0 case▌            q/esc back
```

- **Overlay** via `ctx.ui.custom(..., { overlay: true })`: full keyboard while
  open, main session untouched underneath, esc unwinds chat → list → main.
- **List pane**: scan `async-subagent-runs/*/status.json`, filtered and capped
  the way the artifacts demand (443 dirs on this machine today, most of them the
  foreign extension's own test residue — an unfiltered scan is garbage). Sort by
  `lastUpdate`; show state glyph, agent, elapsed, model.
- **Chat pane**: tail the child's **session file** incrementally, parse JSONL
  records into pi message objects, render through **pi's own components**
  (`AssistantMessageComponent`, `ToolExecutionComponent`, `UserMessageComponent`).
  Collapsed/expanded via `setExpanded`; never `markExecutionStarted()` (the
  component would time its own replay and print `Took 0.0s` over the recorded
  duration — verified against pi 0.84.1); durations rendered from the records.
- **Composer**: a single input row. Enter writes a steer request; the row shows
  its lifecycle from the ack file (`queued n/20` → `delivered` → failed), plus
  `i` interrupt / `D` stop through the same inbox.

### Why pi's components are right here (and were wrong upstream)

The stock inspector's compact pane is a *monitoring strip*; jamming pi's chat
components into it regresses it (measured: collapsed `read` renders only its
call row, rail framing breaks, hint names a key the pane doesn't own). This hub's
chat pane is the opposite case — a full-width conversation view, which is exactly
what those components draw. Same components, opposite verdicts, because the panes
have different jobs.

Rendering through pi's real component prototypes also means any extension that
restyles pi's transcript restyles this hub automatically — no coupling, no
knowledge in either direction, it degrades to stock pi's look when nothing is
patching.

## The control plane (as installed, 0.46.0)

**Primary — RPC over `pi.events`.** Envelope
`{version: 1, requestId, method, params?, source: {extension: "pi-agent-hub"}}`
emitted on `subagents:rpc:v1:request`; the reply arrives once on
`subagents:rpc:v1:reply:<requestId>` (subscribe before emitting, keep a
timeout). `subagents:rpc:v1:ready` fires at startup with the manifest —
methods, per-capability versions (`fleetStatus`, `processTerminalProof`, …),
event names, and the host session. The manifest is the compatibility check:
gate each hub affordance on the capability it needs, not on a version guess.
`steer` takes `{id|runId|dir, message, mode?: steer|follow_up|auto}` and
answers with `{steering: {requestId, state, deliveryStatus, targets[]}}`;
completion signals also arrive as broadcast events (`subagent:async-complete`,
`subagent:process-terminal`).

**Fallback — the `control/` file inbox** (detached runners only): steer
requests as `steer-requests/<ts13>-<b64url(id)>.json`
(`{type:"steer", id, ts, message, mode?, source?}`, message ≤ 128 KB, queue
≤ 20, atomic temp+rename in the same dir), acks in `steer-acks/<index>/`,
runner capability in `steer-capabilities/<index>.json`, plus
`interrupt.json` / `stop.json`. Capability and `steer-inbox-closed.json` gate
the composer: absent watcher or closed inbox renders it disabled rather than
pretending.

## Coupling policy

This extension knows `pi-subagents` by name — that is its job, and unavoidable:
dir layout, `status.json` schema, control protocol. Managed the way the other
extensions in this stable manage foreign knowledge:

- **Version probe.** Read the installed package's version at startup; the
  protocol reader carries the version it was written against. On mismatch, keep
  working but say so once.
- **Assumption inventory + degrade.** Every schema assumption listed in one
  place; a run dir that stops parsing is hidden, a steer schema that stops
  matching downgrades the hub to view-only. Never crash the overlay over a
  foreign format change.
- **Reimplement, don't import.** The protocol is ~100 lines of JSON-file IO.
  Importing the foreign extension's own modules at runtime would track drift
  automatically but executes unvetted side effects and couples to internal APIs
  that churn faster than the disk format (which cross-version compatibility
  pressures keep stable — old runners must stay controllable).
- Session-file parsing couples to **pi core's** format, which is versioned
  (`{type:"session", version}` header) and far stabler than any extension.

## Phases — v0 and v1 and v2 are implemented; two facts learned landing them

- **Control is session-scoped upstream.** Every RPC control method checks the
  run's recorded `sessionId` (the session *file* path — `resolveCurrentSessionId`
  prefers `getSessionFile()`) against the live session and answers `not_found`
  for foreign runs. The hub therefore labels foreign runs view-only up front,
  and reaches live foreign runners only through their file inbox, which has no
  session check because being the cross-process channel is its purpose.
- **Resume creates a revival run.** Resuming spawns a *new* run directory (with
  the detached runner, capability files and logs) that continues the original
  child session file — so the original row's conversation grows while a new
  running row appears. Verified live: resume → capability up in ~1s → steer
  through the composer → delivered between turns → the child obeyed the
  mid-run instruction. Ack files are consumed (deleted) by the owning
  extension, so the hub watches them only on the file-fallback path where no
  owner is alive.

## Phases

- **v0 — observe.** List pane from RPC `status` (structured fleet entries:
  agent, model, tokens, goal), falling back to a filtered `status.json` scan
  when RPC is absent; chat pane tailing the selected child's session file.
  Read-only. Already beats the stock inspector on real runs (which have no
  transcript artifact at all) and shows edit diffs, thinking, full markdown.
- **v1 — type.** Composer over RPC `steer` / `resume` / `interrupt` / `stop`,
  with the per-state delivery semantics above surfaced honestly (live vs parked
  vs revive); lifecycle from the reply's `steering.targets[]`, ack files, and
  the completion broadcast events; file-inbox fallback for orphaned runners.
- **v2 — polish.** Scrollback, search, expand/collapse per tool, `o` to open
  the child's cwd, copy session path, zombie labelling and cleanup hints.

## Risks

| risk | standing |
|---|---|
| RPC drift across pi-subagents versions | the `ready` manifest carries per-capability versions — gate features on capabilities, degrade to view-only, never crash the overlay |
| in-memory tracked runs have no run dir | confirmed real (RPC reported a job with no directory); list = RPC first, disk only as fallback, labelled as such |
| run-dir residue pollutes the fallback list | 443 dirs here, most upstream test residue: filter by parseability + sessionId + entry cap, as upstream's own reader does |
| two writers on a live session file | hard rule: live children are overlay-only; native enter is gated on terminal state |
| session files pruned or missing | tolerate: fall back to `output-N.log` tail, say why |
| headless parents (`pi -p`) auto-drain children in-process | such runs end with the parent; the hub will mostly meet them as history |

## Implementation notes (pinned against pi 0.84.1 / pi-subagents 0.46.0)

Verified from installed `.d.ts` and a real child session file, so v0 starts
here rather than in archaeology:

- **Overlay**: `ctx.ui.custom<T>((tui, theme, keybindings, done) => component,
  { overlay: true, overlayOptions })` — component contract is
  `render(width): string[]` + optional `handleInput(data)`, `dispose()`,
  `invalidate()`. The stock inspector mounts with
  `{ anchor: "center", width: "95%", minWidth: 60, maxHeight: "85%", margin: 1 }`
  and sizes rows from `tui.terminal.rows`.
- **Registration**: `pi.registerCommand(name, { description, handler(args, ctx) })`,
  `pi.registerShortcut(keyId, { description, handler(ctx) })`,
  `pi.events: EventBus` (`on` returns an unsubscribe fn).
- **Components** (all exported):
  `UserMessageComponent(text, markdownTheme?, outputPad?, transformers?)`;
  `AssistantMessageComponent(message?, hideThinkingBlock?, markdownTheme?,
  hiddenThinkingLabel?, outputPad?, transformers?)`;
  `ToolExecutionComponent(toolName, toolCallId, args, options | undefined,
  toolDefinition | undefined, ui: TUI, cwd)` — `setArgsComplete()`, then
  `updateResult({content, details?, isError})`, `setExpanded(bool)`; never
  `markExecutionStarted()` on replay (it fabricates `Took 0.0s`).
  `getMarkdownTheme()` supplies the markdown theme.
- **Session JSONL** (`version: 3`): header
  `{type:"session", version, id, cwd, timestamp}`; entries carry `type` —
  parse `type:"message"` and *skip unknown types* (`model_change`,
  `thinking_level_change`, `session_info` observed). Message shapes:
  user `{role, content:[{type:"text",…}], timestamp}`; assistant
  `{role, content:[thinking|text|toolCall blocks], model, usage, stopReason,…}`
  with toolCall blocks `{type:"toolCall", id, name, arguments}`; toolResult
  `{role, toolCallId, toolName, isError, content:[…], details?, timestamp}`.
  Pair toolCall → toolResult by `toolCallId`.
- **List-pane pragmatics**: RPC `status` fleet entries carry no runId or
  sessionFile — so the disk scan drives the list (runId, per-step
  `sessionFile`, `currentTool`, `lastActivityAt` all live in `status.json`),
  with RPC supplementing liveness and dir-less tracked jobs (rows without a
  chat pane). Residue filter: keep runs whose `sessionFile` exists; zombie =
  `state === "running"` with stale `lastUpdate`.

## Probe findings (2026-08-12, this machine, pi 0.84.1 + pi-subagents 0.46.0)

- 375 parseable run dirs; real runs' `sessionFile` always present under
  `~/.pi/agent/sessions/`, 12/12 surviving completion; `transcriptPath` null on
  all real runs (populated only in upstream's own test residue).
- RPC from a foreign extension: `ready` manifest received at startup; `ping` and
  `status` (structured fleet v1) answered; `steer` against a live child accepted
  → `queued`, request id + per-target state returned.
- Attached children are separate pi processes but hold **no** `control/` inbox
  (steer env unset; watcher lives only in the detached runner) — file-based
  steer correctly did nothing until a runner exists.
- Child session file (`version: 3`) confirmed created immediately and growing
  during the run, nested under the parent session's directory.
- RPC steer against a live attached run: accepted (`queued`, request id
  returned) but **parked** — the run completed with the request file still
  unconsumed in `control/steer-requests/`; nothing delivers it until a runner
  exists. Delivery-state honesty in the composer is a hard requirement.
- Parent death (SIGHUP/pty kill, and `timeout`-killed headless parent):
  children die, no runner spawns, `status.json` strands at `running` — zombie
  detection via `lastUpdate` staleness is required. Graceful-quit handoff was
  not probed (0.46 has no close-grace; 0.47 adds it).
- RPC `spawn` works from a foreign extension (workflowScript form only:
  `return runs.run('main', { agent, task })`); direct params are rejected with
  a helpful error.
- The four real runs with runner artifacts all carry
  `recovery-descriptor.json` → detached runners come from resume/revival, not
  from launch.

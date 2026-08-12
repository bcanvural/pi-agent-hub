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

### Why RPC-first and not the file protocol

The `control/` file inbox (steer requests, acks, capabilities, interrupt/stop —
schema-only validation, atomic writes, 250 ms poll) is real, but it is consumed
**only by the detached runner process**, and probing showed runs don't have one
while their parent pi is alive: attached children are separate pi processes
*without* the steer env, hosted in-process by the extension, with no `control/`
dir at all. Some runs never touch disk in the first place — RPC `status`
reported a tracked job with no run directory anywhere. So:

- **RPC** reaches everything its extension can reach — attached, detached,
  in-memory — and routes each through the right channel itself.
- **Files** reach only detached runners, the minority case, and couple us to
  dir-layout archaeology instead of a versioned envelope with a capability
  manifest.

The file protocol therefore demotes to a *fallback*: reading `status.json` for
run discovery when RPC is absent (extension not installed, or inspecting another
process's leftovers), and — at most — direct inbox writes for orphaned detached
runs. The hub is a cockpit; `pi-subagents` stays the driver.

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

## Phases

- **v0 — observe.** List pane from RPC `status` (structured fleet entries:
  agent, model, tokens, goal), falling back to a filtered `status.json` scan
  when RPC is absent; chat pane tailing the selected child's session file.
  Read-only. Already beats the stock inspector on real runs (which have no
  transcript artifact at all) and shows edit diffs, thinking, full markdown.
- **v1 — type.** Composer over RPC `steer` (+ `interrupt` / `stop`); delivery
  lifecycle from the reply's `steering.targets[]` plus completion broadcast
  events; file-inbox fallback for orphaned detached runs.
- **v2 — enter/return + polish.** For **completed** runs only: native
  `switchSession(childFile)` → converse → switch back (two-writers rule: never
  while a runner owns the file). Scrollback, search, `o` to open the child's cwd,
  copy session path.

## Risks

| risk | standing |
|---|---|
| RPC drift across pi-subagents versions | the `ready` manifest carries per-capability versions — gate features on capabilities, degrade to view-only, never crash the overlay |
| in-memory tracked runs have no run dir | confirmed real (RPC reported a job with no directory); list = RPC first, disk only as fallback, labelled as such |
| run-dir residue pollutes the fallback list | 443 dirs here, most upstream test residue: filter by parseability + sessionId + entry cap, as upstream's own reader does |
| two writers on a live session file | hard rule: live children are overlay-only; native enter is gated on terminal state |
| session files pruned or missing | tolerate: fall back to `output-N.log` tail, say why |
| headless parents (`pi -p`) auto-drain children in-process | such runs end with the parent; the hub will mostly meet them as history |

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
- RPC steer delivery into the child's conversation: _pending below._
- Parent-quit handoff to a detached runner (file-steerable): _pending below._

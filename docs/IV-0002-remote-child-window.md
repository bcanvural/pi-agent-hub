# IV-0002 — Remote Child-Session Window

**Status:** experimental / deferred  
**Root:** this document  
**Scope:** a possible native-looking remote window for a selected child Pi session

## Intent

Give the pi-agent-hub user a focused, Pi-like window for inspecting and talking to
a selected child session while the child remains a separate process and retains
ownership of its session, editor, event loop, and writes.

This is an experimental future initiative. It is documented now to preserve the
idea and its boundaries, not to create a near-term implementation commitment.
The detailed design sketch is [remote-child-window.md](remote-child-window.md).

This initiative follows the workspace doctrine in
[DC-0001](DC-0001-agentic-workspace.md) and shares conversation/lineage identity
work with [IV-0001](IV-0001-agent-hub-hierarchy.md), but it must not become a
reason to destabilize the current flat hub roster.

## Desired user outcome

For a selected child, the hub could provide:

- a conversation body rendered with Pi's own message, markdown, tool, diff, and
  theme components;
- a bounded live transcript viewport with incremental updates;
- a composer that honestly reports whether a message was delivered, queued,
  parked, resumed, unavailable, or view-only;
- interrupt, stop, steer, and resume controls routed to the child owner;
- enough identity, lifecycle, usage, and lineage context to explain what is being
  viewed;
- a clear return path to the parent Pi conversation.

“Native-looking” means visual and interaction fidelity. It does not mean turning
the child into the parent process's actual focused Pi session.

## Experimental boundary

The child remains the owner of:

- the real session file and transcript writes;
- model turns and tool execution;
- the child editor and extension context;
- lifecycle state and event loop.

The hub is only a remote viewer/controller. It reads session and status artifacts,
renders a projection, and sends actions through the existing control plane. It must
never take over the child terminal or write the child's session/status files.

The first eventual implementation should remain extension-only. Pi core or
`pi-subagents` changes are research options, not prerequisites or current work.

## Proposed topology

```text
parent Pi process
  └─ pi-agent-hub remote window
       ├─ reads session/status/output projections
       ├─ renders with Pi components
       └─ sends capability-gated controls
            │
            ▼
       child Pi process / detached runner
            └─ owns the real session and session file
```

## Working decisions

### Use the existing conversation identity model

The visible window represents a conversation, not an arbitrary async-run record.
The window must consume the flat/tree identity projection from IV-0001:

- revivals sharing a session file are one conversation;
- workflow shells are bookkeeping nodes unless they are the only operational
  record available;
- nested workflow relations must remain complete;
- labels, models, cwd, and timestamps never establish identity by themselves;
- ambiguous or conflicting session paths remain view-only/unknown rather than
  being guessed together.

### Use Pi rendering primitives, not a parallel renderer

Reuse `SessionTail`, the bounded chat-window logic, Pi's assistant/tool/user
components, markdown theme, diff renderer, and width discipline. A separate
renderer would drift visually and repeat the host-safety problems already solved
by Pi.

### Keep the composer outside the child transcript

The hub owns its input editor. It sends a steer or resume request through RPC or
the documented fallback inbox; it does not inject synthetic user messages into the
child's session file. Action notices must be scoped to the selected conversation
and must describe observed delivery state rather than intent.

### Defer native focused-session behavior

A real focused child session would require supported Pi-core session-focus or
registry machinery. More `pi-subagents` metadata cannot transfer the child's
editor, component instances, extension context, or event loop. Treat that as a
separate future initiative if the extension-only window demonstrates a concrete
limitation.

## Expected surfaces

### Header

Show sanitized, width-bounded identity and state:

- agent/conversation label;
- model and thinking level;
- run/conversation grouping indicator;
- running, waiting, stale/unknown, complete, failed, or stopped state;
- token and cost summary from the canonical session accounting;
- a compact indicator when several lifecycle records represent the conversation.

### Conversation body

- Incrementally tail hostile append-only JSONL.
- Render only the viewport, not the whole potentially multi-megabyte session.
- Preserve Pi's markdown, thinking, tools, diffs, links, and expansion behavior.
- Optionally show transient output/tool activity that has not reached the session
  file, clearly distinguished from persisted conversation content.

### Composer and controls

- Start with bounded single-line input; add multiline editing only if evidence
  requires it.
- Use steer for a live child and resume for a finished/resumable child.
- Keep interrupt and stop explicit.
- Show accepted, queued, delivered, parked, failed, view-only, resumed, or unknown
  outcomes honestly.
- Fall back to a read-only transcript when the child disappears or capabilities
  are unavailable.

### Navigation

Preserve the parent hub's overlay contract. Navigation, search, expansion, and
composer editing stay local to the remote window. Escape/q returns to the parent
conversation. Resizing should preserve the live tail rather than pretending an
old line offset still identifies the same message.

## Implementation locations and consumers

| Location | Future responsibility |
|---|---|
| `src/session-view.ts` | Incremental transcript tailing and Pi-native conversation rendering |
| `src/hub.ts` | Open/close remote window, selected conversation, view state, and notices |
| `src/runs.ts` | Stable conversation and lineage projection consumed by the window |
| `src/rpc.ts` | Capability-gated steer/resume/interrupt/stop requests |
| `src/control-files.ts` | Documented fallback inbox and acknowledgement reads |
| `src/output-tail.ts` | Bounded sanitized transient output projection |
| `src/supervisor-channel.ts` | Waiting-for-supervisor state and expiry interpretation |
| `DESIGN.md` | Ownership, topology, and read/write boundaries |
| `pi-subagents` | No required changes for the first extension-only version |

Primary consumer: the `/hub` overlay. A future remote window must also work with
flat and tree hierarchy modes without inventing a second conversation identity.

## Non-goals

- No implementation commitment in the current roster/hierarchy work.
- No writes to child `session.jsonl` or `status.json`.
- No child terminal takeover or native focused-session claim.
- No replacement for the parent Pi editor or event loop.
- No unbounded transcript rebuild or unsanitized foreign rendering.
- No change to `pi-subagents` or Pi core merely to make the first experiment look
  more native.
- No promise of token streaming or exact child-local transient widgets from
  persisted artifacts alone.

## Open questions

- Is the extension-only viewer sufficiently useful without a real focused editor?
- Which controls need stronger accepted/queued/delivered acknowledgements?
- Should transient assistant/tool deltas be added to the protocol, or is output-tail
  projection enough?
- Should `pi-subagents` publish a canonical conversation/session id across original
  runs, revivals, and workflow shells?
- If upstream protocol work becomes justified, which capabilities and versioned
  events are the smallest useful addition?

These questions are deliberately unresolved while the initiative is deferred.

## Evidence and reproduction

No production implementation is claimed. When this initiative is resumed, begin
with synthetic fixtures and a scratch project; keep real child artifacts read-only.

The first experiment should verify:

1. a large session renders only the selected viewport;
2. partial JSONL lines and in-place foreign rewrites do not crash or corrupt the
   view;
3. a live child, parked child, stale/unknown child, supervisor-waiting child, and
   vanished child receive honest states;
4. steer, resume, interrupt, and stop notices reflect actual acknowledgements;
5. conflicting or missing conversation identity degrades to a safe read-only view;
6. every rendered row remains sanitized and within terminal width;
7. the parent Pi session remains usable if the remote child or protocol disappears.

Required repository checks remain:

```text
npm run typecheck
git diff --check
```

The detailed design sketch records the current protocol assumptions and should be
reread before any implementation starts.

## Child documents

- [Remote child-session window design sketch](remote-child-window.md) — detailed
  topology, data/lifecycle model, rendering fidelity, safety boundaries, and the
  current decision to defer implementation.

Any future child document must link back to this root IV.

## Revision notes

- Initial initiative: preserve the experimental remote-window concept as a
  deferred, extension-only possibility with explicit ownership and safety limits.

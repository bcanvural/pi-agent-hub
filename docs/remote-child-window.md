# Remote child-session window

**Status:** child design sketch for [IV-0002](IV-0002-remote-child-window.md); experimental and deferred. This is intentionally not an implementation plan for the current change.

## Summary

Make the hub's conversation pane feel like a complete Pi window for the selected
child: native Pi message rendering, a real composer, scrolling/search, live
activity, and the same controls a user would expect from an interactive Pi
conversation.

The child remains a separate Pi process. The hub is a remote client/viewer for
that process; it never writes the child's session file and never tries to take
over the child's terminal.

## What “native” means here

There are two different goals:

1. **Native-looking window:** use Pi's own message components, markdown theme,
   tool renderers, diff renderers, and width rules. This is achievable in an
   extension and is already what `src/session-view.ts` does.
2. **Native focused session:** make the child become the current Pi session,
   with its live editor, component instances, extension context, and event loop.
   This needs Pi-core session-focus machinery; it is not provided by the stock
   extension API.

This design targets the first goal. It should look and feel close to omp while
remaining an honest remote window.

## Topology

```text
parent Pi process
  └─ pi-agent-hub overlay
       ├─ reads status.json / session.jsonl / output logs
       ├─ renders the child with Pi components
       └─ sends RPC controls
            │ subagents:rpc:v1
            ▼
       child Pi process / detached runner
            └─ owns the real session and session.jsonl
```

The overlay owns presentation and input. `pi-subagents` remains the owner of
child execution, session writes, model turns, and lifecycle decisions.

## Proposed window

### Header

- Agent name, model, thinking level, and run/conversation identity.
- Running, waiting-on-supervisor, stale/unknown, complete, failed, or stopped
  state.
- Token/cost summary from the canonical session file.
- A compact indicator when the selected row represents several lifecycle
  records (original run, revival, or workflow shell).

### Conversation body

- Reuse `SessionTail` for hostile, append-only JSONL reading.
- Reuse `buildChatWindow` and Pi's `AssistantMessageComponent`,
  `ToolExecutionComponent`, and `UserMessageComponent`.
- Keep the viewport windowed; never rebuild a multi-megabyte session on every
  frame.
- Preserve Pi's native markdown, thinking blocks, tool boxes, diffs, links, and
  expansion behavior.
- Add a transient activity rail for output/tool progress that has not yet been
  persisted to the session file.

### Composer

The composer is owned by the hub, not injected into the session file.

- Single-line input initially; multiline editing can be added later.
- Enter sends through the selected channel.
- A live child uses `steer`; a finished or resumable child uses `resume`.
- Interrupt and stop remain explicit controls.
- The status line must distinguish accepted, queued, delivered, parked, failed,
  view-only, and resumed. It must never claim that a message was delivered when
  the child is blocked or no runner is reading the inbox.

### Navigation

Keep the hub's existing overlay escape contract:

- navigation keys select or scroll without affecting the parent conversation;
- search and tool expansion stay local to the selected child;
- `q`/Escape returns to the parent Pi conversation;
- resizing returns to the live tail rather than pretending an old line offset
  still identifies the same message.

## Data and identity

The visible item is a **conversation**, not a raw async-run record.

Primary identity is the child's session file. A revival can have a new run id
while continuing the same file, so those records must collapse into one row.
Workflow shells are bookkeeping records. When a shell temporarily lacks its
step's session file, link it to the child using
`parentWorkflowRunId` + `workflowKey`; only borrow a session path when that
relation names one unambiguous path. Prefer the actual child record for
selection and controls.

No display identity should be inferred from an agent label alone: two different
children can use the same agent name.

## Live-state model

The session file is authoritative for conversation content. Other surfaces fill
in transient state:

- `status.json`: lifecycle, current tool, activity, model, and run relations;
- output log: useful tail while a tool call has not produced a session record;
- supervisor channel: a child waiting for a reply;
- RPC/control acknowledgements: delivery state for user actions.

A parked child is still alive. An expired supervisor request with a frozen
heartbeat is unknown, not automatically stale. This distinction must be
reflected in the header, action row, and controls.

## Rendering fidelity and known differences

This can be visually native because it uses the same Pi components and theme.
It cannot reproduce every native lifecycle detail from persisted data alone:

- token streaming and partial assistant text are not complete session records;
- in-flight tool progress needs status/output signals beside the transcript;
- component-local state and child-specific transient widgets are not serialized;
- the hub's editor and keybindings belong to the hub, not the child process.

If exact live component behavior becomes a requirement, the boundary moves from
“render the session file” toward a Pi-core session-focus/registry API. That is a
different project from this remote window.

## Does `pi-subagents` need changes?

### Minimum design: no

The current integration already provides the required control plane:

- run discovery and session-file paths in artifacts;
- `status`, `steer`, `resume`, `interrupt`, and `stop` through the versioned RPC;
- detached-runner capabilities, inboxes, and acknowledgements;
- lifecycle broadcasts;
- supervisor-channel files for a waiting child.

The window can therefore be implemented entirely in `pi-agent-hub`, with the
existing capability-gated RPC and read-only artifact readers.

### Optional upstream improvements

Changes to `pi-subagents` would improve fidelity and reduce coupling, but are
not prerequisites:

- expose a stable canonical conversation/session id across original runs,
  revivals, and workflow shells, rather than making clients join records from
  several fields;
- include workflow-child identity and the canonical session path consistently
  in every status step, including resumed workflow shells;
- publish a capability-gated stream of assistant deltas and tool-progress
  events for smoother in-flight rendering;
- expose a structured “message accepted/queued/delivered” event stream so a
  client need not inspect runner acknowledgement files;
- expose a small canonical conversation snapshot if clients should not depend
  on the artifact directory layout.

Those are protocol-quality improvements, not requirements for the popup. They
should be versioned capabilities, not assumptions tied to a package version.

### What would not be solved by `pi-subagents` alone

Making the child the *actual focused Pi session* would require Pi-core support
for session focus/registries (or an equivalent supported embedding API). Adding
more lifecycle fields to `pi-subagents` would not transfer the child's editor,
component instances, extension context, or event loop into the parent window.

## Safety boundaries

- Never write `session.jsonl` or `status.json`.
- Keep all foreign strings sanitized at their render sites.
- Keep every rendered row within the terminal width.
- Keep one writer for the child session: the child process only.
- Route controls through RPC first and the runner inbox only as the documented
  fallback.
- Treat status and acknowledgement files as hostile, partial, and replaceable.
- Keep the parent Pi session usable if the child disappears or the protocol
  changes; degrade to a read-only transcript or an honest unavailable state.

## Decision

When this is revisited, start as an extension-only remote window. Do not modify
`pi-subagents` or Pi core for the first version. Revisit upstream protocol work
only if streaming fidelity, canonical cross-revival identity, or artifact-layout
independence becomes a demonstrated limitation.

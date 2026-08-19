# IV-0001 — Agent Hub Flat and Hierarchy Views

**Status:** implemented and approved  
**Review status:** design: 3 rounds accepted; implementation: 3 rounds accepted (Pass 1 `deepseek-v4-flash:max`, Pass 2 `gemini-3.7-flash:high`, Pass 3 `gpt-5.6-sol:high`; all approved)  
**Root:** this document  
**Scope:** the pi-agent-hub roster, run identity, and lineage views

## Intent

Make the hub understandable when one user-visible conversation is represented by
several execution records: original runs, revivals, workflow shells, and nested
workflow children.

The normal roster should answer **“which conversations can I inspect or control?”**
An optional hierarchy view should answer **“which runs and workflow shells produced
this conversation?”** without making the everyday roster noisy or unstable.

This initiative explains why the run-reconciliation and roster-projection changes
exist. It consumes the workspace guidance in [DC-0001](DC-0001-agentic-workspace.md)
and complements the extension-only remote window described in
[remote-child-window.md](remote-child-window.md).

## User outcome

A user can:

- see one flat row for one conversation, rather than a phantom row for every
  lifecycle record;
- rely on the flat roster not moving when another child emits output;
- toggle to a parent/child view when workflow structure matters;
- distinguish a bookkeeping workflow shell from the actual child conversation;
- open the conversation and send controls to the record that can actually receive
  them;
- see incomplete or ambiguous lineage honestly instead of losing a row or merging
  unrelated children.

## Context and important facts

The hub reads artifacts written by another process. It does not own a registry of
live agents and cannot assume that one status record is one conversation.

Relevant records include:

- an ordinary child run with a session file;
- a revival with a new run id and the original session file;
- a workflow shell whose step may temporarily have no session file;
- a workflow child linked by `parentWorkflowRunId` and a lane key;
- a nested workflow that is both a child of an outer workflow and a shell for an
  inner child.

A session file is the strongest available conversation identity. A label, model,
cwd, timestamp, or workflow lane by itself is not an identity. Distinct children
may share all of those values.

The current scanner has a known limitation: a nested shell may expose different
outer and inner lane keys, while the normalized row retains only one `workflowKey`.
That loses one relation and can make the shell or its outer conversation disappear
during residue filtering. The identity model must be corrected before hierarchy
rendering is considered complete.

## Working decisions

### Flat view is the default

The default view is one row per deduplicated conversation. It uses newest recorded
creation time first and a deterministic identity tie-breaker. Output activity never
reorders the roster.

A merged conversation's ordering key is computed from the whole group before the
survivor is selected. This prevents a newer workflow shell or revival from being
hidden behind an older child when the display cap is applied.

The selected survivor should normally be the actual child rather than a root
workflow shell. Liveness and action capability may select the operational record,
but must not change the conversation's ordering key.

### Hierarchy view is opt-in

Add a toggle, following OMP's `t` / “By parent” precedent (which does not
collide with any existing hub keybinding), for a tree of execution records:

```text
workflow shell
├── child conversation
└── nested workflow shell
    └── inner child conversation
```

The tree view is a diagnostic and lineage view, not a second conversation roster.
It operates on the **pre-residue linked run graph** rather than the flat residue-filtered
roster, ensuring that sessionless non-leaf workflow shells and ambiguous/conflicted
lineage nodes remain visible in the tree.

Key tree projection and runtime rules:
- **Scanner data flow separation:** The scanner API returns a structured result
  `{ kept: RunRow[]; linked: RunRow[] }` (or equivalent graph accessors). Flat mode
  consumes `scoped.kept` (residue-filtered, deduplicated conversation rows sorted by group
  creation time). Tree mode consumes `scoped.linked` (all in-scope pre-residue linked rows),
  retaining non-leaf workflow shells and conflicted nodes.
- **Per-run shell collapsing:** Multi-step workflow shells collapse into a single
  workflow run node whose children are its workflow lanes/steps, rather than emitting
  redundant sibling shell step nodes.
- **Deduplication:** When a shell step already carries the child's session file inline,
  the tree projection unifies the node with the child conversation rather than
  duplicating sibling rows.
- **Cursor tracking vs action routing:** The navigation cursor (`selectedKey`) stably
  tracks the highlighted tree node directly (whether shell or child) so j/k navigation
  never jumps unexpectedly. When Enter or a lifecycle action is invoked on a shell node,
  it resolves to the operational child `RunRow` if unambiguous; if multi-lane or
  unlinked, the action is rejected with an informative notice (`workflow shell — select specific child step to control`).
- **RPC and control target precision:** All lifecycle actions (`steer`, `resume`,
  `interrupt`, `stop`) through RPC (`src/rpc.ts`) and fallback control inboxes
  (`src/control-files.ts`) must carry both `id` and `index` for multi-step child runs.
  Action routing validates that the target step is uniquely addressable; unaddressable
  steps are rejected with an honest label rather than dispatching a generic run-level
  resume that could steer the wrong step.
- **Chat pane rendering on shell nodes:** If a highlighted shell node has an unambiguous
  child session file, the chat pane tails that conversation with a shell header annotation;
  if sessionless or multi-lane, it renders a concise workflow step summary instead of a
  broken/empty pane.
- **Tree usage attribution and headline deduplication:** A workflow shell node that shares
  a session file with its child displays `shared` (or references the child spend); a
  sessionless shell displays `—`. The actual child conversation node displays the canonical
  session spend. The aggregate headline spend deduplicates across unique session files
  (`Set<UsageMeter>`), strictly charging each session file once (Invariant 8).
- **Uniform row height and viewport windowing:** Tree mode enforces a uniform 2-line row
  height per entry (Line 1: branch prefix + glyph + agent label + recency; Line 2: indented
  metadata/model/usage), preventing scroll-jitter. The tree projection flattens into an
  ordered display array (parent-before-child, newest root subtree order), capped at
  `MAX_ROWS`, which passes through standard `listWindowTop` / `visibleEntries` windowing.
- **Width discipline:** All tree lines pass through code-point-aware `truncateToWidth(line, listWidth)`.
  Pathological nesting depth clips leading ancestry branch segments from the left
  (OMP `treeBranch` pattern) to strictly preserve terminal width bounds (Invariant 2).
- **Scope filter precedence:** Scope filtering (`session` / `project` / `machine`) applies
  before tree graph projection. An in-scope child whose parent workflow shell is out of
  scope renders gracefully as a top-level root node with an unlinked parent indicator
  rather than disappearing (Invariant: *Never hide a row solely because its parent is missing or malformed*).
- **Iterative bounded walk:** The projection must use an iterative, stack-safe walk
  with a strict node and depth cap (`visited` set + `depthById`), preventing cycle
  hangs and preserving event-loop performance (Invariants 1 and 5).

The flat view remains the place for normal navigation and control. In the tree,
Enter and lifecycle actions route to the active/actual child when the selected node
is only a bookkeeping shell. If routing cannot be established, the UI says so
rather than claiming that the shell was controlled.

### Preserve all available workflow relations

A normalized run record must not collapse multiple workflow relationships into one
field. Upstream writes run-level `status.workflowKey` for a shell's outer lane
and step-level `step.workflowKey` for its inner child lane. A nested shell needs to
retain both distinct relation edges on `RunRow`:

1. **`parentWorkflowKey?: string`** (outer relation): parsed from `status.workflowKey`
   when `parentWorkflowRunId` is present.
2. **`stepWorkflowKey?: string`** (inner child relation): parsed from `step.workflowKey`
   (or `status.workflowKey` for non-nested steps).

`rowsFromStatus` stores both fields independently without coalescing. `linkWorkflowSessionFiles`
generates outer edge keys with `[row.parentWorkflowRunId, row.parentWorkflowKey]` and
inner edge keys with `[row.runId, row.stepWorkflowKey]`, guaranteeing that neither edge
is dropped when outer and inner lane keys differ.

Build connected components from those edges before borrowing a session path. Borrow a
path only when the complete component names exactly one unique session file. If a
component names conflicting files, keep the ambiguity visible and do not guess.

Missing parents, missing keys, malformed foreign metadata (e.g. negative timestamps,
which must be normalized to neutral), and lineage cycles must remain visible as
unknown/root records rather than disappearing.

## Reference pattern: OMP

The installed OMP Agent Hub uses a native registry entry per agent with stable
`id`, explicit `parentId`, `createdAt`, and `lastActivity` fields. Its default
roster is flat; `t` projects the same entries into a parent-before-child tree. It
does not merge a parent and child into one agent because the registry establishes
lineage and session ownership at creation time.

External reference sources from the global oh-my-pi install
(`~/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent` v17.3.7):

- `src/registry/agent-registry.ts` — stable agent and parent identity;
- `src/modes/components/agent-hub.ts` — flat roster, captured row order, and the
  flat/tree toggle (`t` key);
- `src/modes/components/agent-hub-projection.ts` — parent-before-child projection
  and cycle fallback with iterative `visited` walk;
- `src/registry/persisted-agents.ts` — reconstruction of persisted parentage from
  the session directory.

Note: `pi-agent-hub` runs on stock `@earendil-works/pi-coding-agent` and only adapts
the conceptual hierarchy and projection design without depending on `@oh-my-pi`
packages. OMP's identity model is the lesson to copy, not its activity-based
initial sort: this hub's flat ordering requirement remains creation-time ordering.

## Identity model

Keep these concepts separate:

| Concept | Meaning | Use |
|---|---|---|
| Run identity | One status step in one artifact directory | selection, status, control fallback |
| Lineage identity | Parent/child workflow edges | hierarchy projection |
| Conversation identity | The session/chat being rendered | flat grouping and transcript selection |
| Group ordering | Newest recorded creation time in a conversation group | stable flat roster order |

A row key remains deterministic and unique for selection bookkeeping. It must not be
used as a substitute for conversation identity when records share a session file.

## Invariants

- Never merge by agent label, model, cwd, timing, or lane label alone.
- Never let output activity reorder the flat roster.
- Sort merged groups before applying the display cap.
- Never write foreign session or status artifacts.
- Never hide a row solely because its parent is missing or malformed.
- Never borrow a session file across conflicting identity components.
- A shell row wears its own step status in the hierarchy; run-level wrapper status
  must not overwrite a child step's status.
- Every rendered foreign string remains sanitized and width-bounded.
- An action label names what actually happened: delivered, queued, parked, view-only,
  unavailable, or unknown.
- Action notices and ack watches are keyed by conversation identity (`sessionFile ?? rowKey(target)`).
  In tree mode, `visibleNotice()` checks both the direct highlighted `selectedKey` and
  its resolved operational child key so feedback is never blanked when highlighting parent shells.
- Usage token spend must follow Pi's canonical four-field sum (`input + output + cacheRead + cacheWrite`)
  across all three record shapes (`message.usage`, top-level compaction, top-level branch-summary),
  strictly matching `getUsageCostBreakdown` (`core/usage-totals`). Active files continue
  under rotating scheduled re-look (`advanceUsage`) so running meters converge honestly.

## Implementation locations and consumers

| Location | Responsibility in this initiative |
|---|---|
| `src/runs.ts` | Parse run metadata with distinct `parentWorkflowKey` and `stepWorkflowKey` fields, preserve workflow edges, reconcile session identity, and expose `{ kept, linked }` graph outputs |
| `src/hub.ts` | Maintain flat/tree view state, project groups or lineage nodes, select survivors, and route actions |
| `src/session-view.ts` | Render the selected conversation through Pi's message components |
| `src/rpc.ts` | Deliver capability-gated controls (`steer`, `resume`, `interrupt`, `stop`) with explicit `{ id, index }` step targeting |
| `src/control-files.ts` | Read capabilities/acks and write only the documented fallback inbox with step index precision |
| `src/usage.ts` | Maintain four-field token accounting matching Pi's `getUsageCostBreakdown` and rotating re-look |
| `DESIGN.md` | Record the durable topology and ownership boundary |
| `docs/remote-child-window.md` | Separate remote-window interaction design; link back here when identity details change |

Primary consumer: the `/hub` overlay in the parent Pi session. Future consumers may
include a remote child-session window, but that window must use the same conversation
and lineage projections rather than inventing a second identity scheme.

## Non-goals

- Do not make the hierarchy view the default roster.
- Do not treat a workflow shell as a second user conversation merely because it has
  its own status file.
- Do not infer a focused native Pi child session; the remote-window design remains
  extension-only.
- Do not modify `pi-subagents` or Pi core as part of the first implementation.
- Do not solve identity by depending on labels or undocumented artifact naming.
- Do not make live artifact fixtures writable; real artifacts remain read-only.

## Evidence and reproduction

Use synthetic temporary artifacts for anything that mutates. Inspect real
`pi-subagents` and Pi session artifacts read-only.

The focused reproduction matrix is:

1. root workflow shell plus child with one shared lane key;
2. nested shell with distinct outer (`parentWorkflowKey`) and inner (`stepWorkflowKey`)
   lane keys, asserting that both edges survive on `RunRow` and connect correctly;
3. inner child carrying the only session file, testing both the transient state
   where the shell step omits the session file and the fully-written state where
   it is present inline;
4. two distinct lanes with the same human-readable label;
5. conflicting session files in one apparent relation component (ambiguity preserved,
   no guessing);
6. revival records sharing one session file;
7. activity changes after creation, equal creation timestamps, and sequential steps;
8. a newer shell plus older child with more than the roster cap of unrelated rows;
9. session-file creation/removal while `status.json` mtime is unchanged;
10. missing, partial, malformed (e.g. negative timestamps), vanished, and cycle-forming
    foreign metadata;
11. multi-step workflow target precision: steer, resume, interrupt, and stop carrying
    `{ id, index }` to the intended child step;
12. usage meter output strictly matching Pi's canonical `getUsageCostBreakdown`
    across assistant messages, compactions, and branch summaries.

Required verification remains:

```text
npm run typecheck
git diff --check
```

Standalone probes should assert both the visible rows and the selected control
identity. A passing probe must not be used as permanent truth without preserving its
fixture and rerunning it after identity or projection changes.

## Child documents

None yet. If the identity model, flat projection, or hierarchy rendering grows
beyond one coherent working context, split it into a child document and link back to
this root IV with the reason for the split.

## Revision notes

- **Implementation review (Pass 1 Flash max, Pass 2 Gemini high, Pass 3 Sol high):** approved.
  Implemented:
  1. Flat view default with group newest-creation ordering and session deduplication (`src/runs.ts`, `src/hub.ts`).
  2. Hierarchy tree view (`t` toggle) projecting from pre-residue linked graph with multi-step shell collapsing (`src/hub.ts`).
  3. Decoupled tree cursor navigation from operational child action routing and chat rendering.
  4. Precise `{ id, index }` RPC and fallback inbox action targeting across steer, resume, interrupt, and stop (`src/rpc.ts`, `src/control-files.ts`, `src/hub.ts`).
  5. Canonical 4-field usage accounting matching Pi's `getUsageCostBreakdown` (`src/usage.ts`).
  6. Foreign metadata sanitization, collision-safe JSON tuple keys, and hostile negative timestamp normalization to neutral (`src/runs.ts`, `src/hub.ts`).
  7. Full 8-group verification test suite (`scripts/test-hierarchy.ts`).
- **Pass 3 design review (gpt-5.6-sol high):** accepted with nits. Added explicit
  `RunRow` schema fields (`parentWorkflowKey` vs `stepWorkflowKey`), structured
  scanner return `{ kept, linked }` data flow, tree usage attribution & headline deduplication,
  multi-step RPC `{ id, index }` target precision, canonical 4-field token sum
  matching Pi's `getUsageCostBreakdown`, and expanded reproduction fixtures.
- **Pass 2 design review (gemini-3.7-flash high):** accepted with nits. Added
  runtime specifications for tree cursor selection independence vs operational child
  action routing, fallback chat rendering for shell nodes, uniform 2-line tree row height,
  leading branch segment truncation for deep nesting, scope filter precedence with orphan
  root resilience, and conversation-level notice keying in `visibleNotice()`.
- **Pass 1 design review (deepseek-v4-flash max):** accepted with nits. Clarified
  tree population from pre-residue linked run graph, per-run shell collapsing,
  two explicit relation key sources (`[parentWorkflowRunId, status.workflowKey]` vs
  `[runId, step.workflowKey]`), global OMP reference paths, and inline-vs-omitted
  sessionFile test coverage.
- Initial initiative: establish flat conversation and opt-in execution-hierarchy
  views, informed by OMP's explicit parent/child registry model.

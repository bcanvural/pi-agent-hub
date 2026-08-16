# `needs_attention` alone renders "waiting on you" for children that are provably working — and stays stale after transport failures

**Repos:** pi-agent-hub (this repo, local `git@github.com:bcanvural/pi-agent-hub.git`), upstream pi-subagents 0.46.0 (npm), pi 0.84.2, macOS. Observed live on 2026-08-16.

## Summary

The hub's `liveness()` marks a child **"parked"** (`waiting on you` / `parked on a
supervisor reply` in the panel) whenever `status.json` carries
`activityState: "needs_attention"` and the row's last beat is younger than
`ASK_TIMEOUT_MS` — with **no cross-check against the supervisor channel**, which
is the only artifact that actually proves a child is blocked on a reply.

Two live failures of that assumption, both observed today in one parent session:

1. A **healthy, actively-working** child (executing tool calls, zero errors, no
   blocking supervisor contact) carried `activityState: "needs_attention"` in a
   **freshly written** `status.json` — the panel said "waiting on you" while the
   child was mid-task. Its only supervisor contact was a
   `contact_supervisor(reason: "progress_update")` that returned in 4 ms
   (`"Supervisor progress update queued."`), which upstream itself classifies as
   non-blocking.
2. A **dead-in-a-retry-loop** child (repeated provider transport failures,
   `stop=error` on every turn) had its `status.json` **freeze** with a stale
   `needs_attention` — the panel kept saying "waiting on you" for a child that
   was failing, not waiting.

## Evidence

### Case A — flag set on a working child (async workflow `90401c05…`, child run `1ba2ef75`)

`status.json` (read at 10:53:31Z, i.e. a **live** write — `lastUpdate` is after
`lastActivityAt`):

```json
{
  "state": "running",
  "lastUpdate": 1786877611861,
  "steps": [{
    "agent": "worker",
    "label": "vision2",
    "status": "running",
    "activityState": "needs_attention",
    "lastActivityAt": 1786877437343
  }]
}
```

`lastActivityAt` (10:50:37Z) is a batch of three successful `read` tool results
in the child's session log. The child's session shows **zero** error tool
results and **zero** `stop=error` turns.

The child's complete supervisor contact history (session log):

```
[5] 2026-08-16T10:45:28.734Z contact_supervisor args={"reason": "progress_update", "message": "Starting targeted screenshot re-analysis …"}
[6] 2026-08-16T10:45:28.738Z contact_supervisor RESULT: "Supervisor progress update queued."
```

Upstream's own gate (`pi-subagents 0.46.0`, `src/runs/background/subagent-runner.ts:338`):

```ts
if (toolName === "contact_supervisor") {
    const reason = (args as Record<string, unknown>).reason;
    return reason === "need_decision" || reason === "interview_request";
}
```

`progress_update` is not blocking by upstream's own definition — and yet
`needs_attention` was set and persisted across status writes for 8+ minutes.

The supervisor channel directory for this child **does not exist**:

```
$ ls …/pi-subagents-uid-501/supervisor-channels/ | grep 1ba2ef75   → (nothing)
```

So `readSupervisorWait()` returns `undefined` — the hub's channel-based park
detection is correctly quiet. The "parked" verdict comes solely from the
`needsAttention` fallback in `src/hub.ts`:

```ts
// src/hub.ts:393
if (row.needsAttention) return now - lastBeat(row, now) < ASK_TIMEOUT_MS ? "parked" : "unknown";
```

with `needsAttention` sourced verbatim from the status file (`src/runs.ts:277`):

```ts
needsAttention: asString(step.activityState) === "needs_attention",
```

No channel lookup, no freshness check of `status.json` itself.

### Case B — flag frozen on a failing child (async workflow `2643de90…`, child run `9f7a5361`)

The child's session log ends in a run of identical failures:

```
[220] 10:34:04Z assistant stop=error   (provider_transport_failure: WebSocket error)
[221] 10:39:07Z assistant stop=error
[222] 10:44:11Z assistant stop=error
```

Its `status.json` froze with `"activityState": "needs_attention"` and
`lastUpdate` stuck at 10:36:44Z (last actual tool activity 10:29:04Z). The hub's
`needsAttention` + fresh-`lastBeat` window (10 min) kept the row "parked" while
the child was in fact failing every retry — the panel read "waiting on you" for
a child that needed a kill, not an answer. (This half also contradicts the
claim in `src/supervisor-channel.ts` that "a parent-hosted run … never gets"
`activityState`; this parent-hosted async workflow clearly does.)

### Case C — flag set on a child that had already finished its deliverable (async workflow `33c2bc05…`, child run `06a185c8`)

Third consecutive run with the same flag pattern. `status.json` read while the
child was mid-task (11:06Z):

```json
{ "state": "running", "steps": [{ "label": "vision3", "status": "running", "activityState": "needs_attention" }] }
```

The child's session log shows it working normally through 11:04:13 — it
**completed its entire deliverable** (report written 11:04:00, existence
verified via bash 11:04:13) — and only its final response-message call died
(upstream `1011`, shim log 11:04:36; see the litellm-ws addendum). The panel
rendered "waiting on you" throughout: the operator is told to answer a child
that needed nothing — its work product was already on disk and only the
wrap-up message had failed. (Same non-blocking `progress_update` startup ping
as Cases A/B; no supervisor channel for this child either.)

### Cross-run tally (2026-08-16, three async runs, one parent session)

| Run | Flag while working? | Real blocking wait? | Outcome |
|---|---|---|---|
| `9f7a5361` (dead worker) | yes (frozen status) | no | 4× `stop=error`, status.json froze with flag |
| `1ba2ef75` (healthy) | yes (live writes) | no | worked; client `1006` at 10:50:37, next turn died |
| `06a185c8` (finished) | yes (live writes) | no | deliverable done; final call died upstream `1011` |

`needs_attention` was set on 3/3 runs regardless of the child's actual
condition, and the hub rendered "parked" on all three.

## Why this is a bug

- **"Parked" is a strong claim.** The hub's own channel reader exists because a
  request file is the only durable proof of a blocking wait — `progress_update`
  requests are deliberately filtered (`readRequest`: `expectsReply` falsy →
  not a wait). The `needsAttention` path bypasses that filter entirely and
  re-claims "parked" from a flag the hub cannot validate.
- **The flag is not trustworthy in either direction.** On a working child it is
  set without any blocking tool (Case A); on a failing child it goes stale
  because `status.json` stops being written (Case B). The hub cannot tell a
  live write from a frozen one today.
- **It points the operator at the wrong action.** "Waiting on you" implies the
  supervisor should reply; both cases required no reply — Case A needed
  nothing, Case B needed a kill/relaunch.

## Proposal (hub side)

1. In `liveness()`, do not return `"parked"` from `needsAttention` alone.
   Prefer: `readSupervisorWait()` found a live wait → `"parked"`; otherwise
   `needsAttention` with a *fresh status file* → a softer state (e.g.
   `"unknown"`, or a distinct "check" state rendered without the
   "waiting on you" wording); `needsAttention` with a stale status file →
   `"stale"`/`"unknown"`.
2. Track `status.json` freshness explicitly (compare `lastUpdate` to wall clock
   on read, not just the step's `lastActivityAt`) — a frozen file must never
   outrank live evidence.
3. (Optional) render the `reason` of the last control event next to a
   `needs_attention` row so the operator sees *why* attention was flagged
   (steering recovery, failed-tool escalation, blocking ask) instead of an
   unconditional "reply required".

## Upstream note (pi-subagents)

`needs_attention` is being set (and persisted) outside the documented blocking
paths — the only upstream setters are the blocking-supervisor-tool path
(`subagent-runner.ts:2764`), steering recovery (`markSteeringAttention`, `:2528`),
and failed-tool escalation (`:2826`); Case A matches none of them. Either the
`isBlockingSupervisorTool` gate is not the only caller, or one of those paths
fires for this run without leaving its control event on disk. Worth an
upstream ticket to (a) identify the setter, and (b) require that the flag be
cleared on the next status write once the triggering condition ends.

## Not verified

- Which upstream code path set `needs_attention` in Case A (no control events
  exist in the run dir; the flag appeared by the 10:53:31Z write).
- Whether the intercom message a supervisor sends to a child's target can
  itself raise the flag (my "acknowledged, continue" message to the child
  precedes the flag's last write by ~1 minute — correlation only, no proof).
- Foreground (non-async) children: the `status.json` artifact does not exist
  for them, so the `needsAttention` fallback is async-run-only by construction.

## Postscript (same day, after Cases A/B were filed)

Case C above repeats the pattern on a third run and adds a sharper framing of
why the rendering is actively misleading: the child had *finished everything
it was asked to do* — the report file existed on disk — and the panel still
said "waiting on you". If the hub's row is meant to drive operator action, the
`needsAttention`-only path should at minimum render as "check on this child"
(with the last control event's reason), never as a supervisor reply request.

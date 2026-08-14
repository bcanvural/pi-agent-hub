# pi-agent-hub

A hub inside [pi](https://github.com/earendil-works/pi) for watching the
agents that [pi-subagents](https://github.com/nicobailon/pi-subagents) runs in
the background — their **full conversations**, live, in one floating panel.

```
╭─ Agent Hub ──────────────────────────────────────────────────────────────╮
│                                                                          │
│ ⟳ 1 running · 4 runs in this session · f scope · 1 active in this session│
│                                                                          │
│ ▸⟳ delegate      gpt-5.6-luna · 4s │ delegate · running · gpt-5.6-luna   │
│    bash · 12s active · 2 req       │                                     │
│  ✓ oracle        gpt-5.6-luna · 1d │  I'll run the exact command with a  │
│    complete · 1m10s · 6 req        │  generous timeout.                  │
│                                    │ ╭─────────────────────────────────╮ │
│                                    │ │ $ for i in $(seq 1 60); do echo…│ │
│                                    │ ╰─────────────────────────────────╯ │
│ s steers the running child · i interrupt · D stop · o cwd · y copy path  │
╰──────────────────────────────────────────────────────────────────────────╯
 J/K·↑/↓ select · j/k·u/d scroll · g/G top/tail · f scope · x expand · …
```

## Why

The runs' own transcript artifacts are lossy monitoring feeds — and often
absent entirely. But every child writes a **real pi session file**, the
complete record: thinking blocks, full markdown, tool calls with their
results and diffs. The hub tails that file and renders it through **pi's own
message components**, so a child's conversation looks exactly like the main
window — including whatever theming or framing other extensions apply to
those components.

Runs are discovered by scanning pi-subagents' artifact root — the only place
that records a run's id and its child's session file. Its versioned
cross-extension RPC (`subagents:rpc:v1:*` on pi's event bus) supplies the
liveness badge alongside. The roster opens scoped to **this session** — the agents this conversation
launched; `f` widens to the project (runs whose recorded cwd is the directory
pi runs in), then the whole machine. The strip names the scope in force.

## Use

```
pi install /path/to/pi-agent-hub        # or -l for one project
```

`/hub` — or `alt+a`, the omp reflex — opens the panel.

| key | action |
|---|---|
| `↑`/`↓` or `J`/`K` | select a run |
| `j`/`k`, `PgUp`/`PgDn` | scroll the conversation |
| `u`/`d` | half-page up / down |
| `g` / `G` | jump to the oldest retained record / back to the live tail |
| `s` / `enter` | message the run — steers it live, or resumes a finished one |
| `i` | interrupt (graceful, resumable) |
| `D D` | stop the run (asks once) |
| `x` / `X` / `ctrl+o` | expand or collapse tool output (for tools pi renders) |
| `/`, then `n`/`N` | search the conversation and walk the matches |
| `o` | open the child's working directory |
| `y` | copy the session file path |
| `f` | cycle scope: session → project → machine |
| `r` | rescan runs |
| `q` / `esc` | back to your conversation |

## Status

v0 — observe. Runs are listed newest-first (one row per step), stale
"running" records from dead parents are labelled rather than believed, and
the conversation follows the session file as it grows.

Only the visible window is rendered, so cost tracks the viewport rather than
the session: a cold pane on a 7 MB transcript is ~40 ms, and every record is
rendered behind a catch, because an exception raised inside pi's render pass
takes the whole session down with it.

Tool output is drawn by pi's own renderers, so expand/collapse behaves as it
does in the main window. A tool with no registered renderer has no collapsed
form to offer — the pane prints what pi prints, bounded only against a
pathologically large result.

Messaging is honest about delivery, because delivery genuinely differs by run
state: a live runner-backed child takes a steer between turns; an attached
child's steer parks until the run is resumed; a finished or stranded run is
resumed — revived with your message, answering into the same pane. Interrupt
and stop ride the same channels. Control is session-scoped upstream, so runs
launched by another pi session are labelled view-only unless a live detached
runner is willing to take file-inbox requests — the one sanctioned
cross-process channel.

While a live child sits inside a long tool call, the pane tails the run's
output log under the transcript — bounded and sanitized — so the wait is
watchable.

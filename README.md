# pi-agent-hub

A hub inside [pi](https://github.com/earendil-works/pi) for watching the
agents that [pi-subagents](https://github.com/nicobailon/pi-subagents) runs in
the background — their **full conversations**, live, in one floating panel.

```
╭─ Agent hub · 19 runs · rpc ✓ · 2 active ────────────────────────────────╮
│ ▸● delegate · bash · 4s     │ delegate · running · gpt-5.6-luna · 0306c5│
│  ✓ oracle · complete · 1d   │                                           │
│  ✓ scout · complete · 1d    │  I'll run the exact command with a        │
│  ✗ worker · failed · 15h    │  generous timeout.                        │
│                             │ ╭───────────────────────────────────────╮ │
│                             │ │ $ for i in $(seq 1 60); do echo …     │ │
│                             │ ╰───────────────────────────────────────╯ │
╰─ ↑/↓ select · J/K scroll · G follow · x expand · r rescan · q close ────╯
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
liveness badge alongside. The two count different populations, so the header
names each: the scan is machine-wide, the RPC reports only this session.

## Use

```
pi install /path/to/pi-agent-hub        # or -l for one project
```

`/hub` opens the panel.

| key | action |
|---|---|
| `↑`/`↓` or `k`/`j` | select a run |
| `J`/`K`, `PgUp`/`PgDn` | scroll the conversation |
| `G` / `End` | jump to the tail and follow live |
| `x` / `ctrl+o` | expand or collapse tool output (for tools pi renders) |
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

Steering, resume conversations, and interrupt/stop controls are designed (see
`DESIGN.md`) and land next.

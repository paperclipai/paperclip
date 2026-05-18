---
name: para-memory-files
description: >
  Tiny file-based memory for turn-0 rules that must apply before any tool call.
  Use this skill ONLY for the small set of rules an agent must obey from the
  first turn of a conversation (e.g. "never commit secrets", "always check X
  before doing Y"). Everything else — durable facts, decisions, history,
  cross-cutting context, code excerpts — belongs in the MemPalace and is
  retrieved via `mempalace_search` / `mempalace_kg_query`. The PARA
  knowledge-graph layer and daily-notes layer have been retired; only the
  short `MEMORY.md` index remains, capped at ~150 lines.
---

# Agent Turn-0 Memory (formerly PARA Memory Files)

**Scope:** this skill now covers ONE thing: a tiny, always-loaded `MEMORY.md`
file of turn-0 rules. The previous PARA knowledge-graph (`life/`) and daily-notes
(`memory/YYYY-MM-DD.md`) layers have been retired in favour of the MemPalace.

## What goes where

| Need                                                        | Use                              |
| ----------------------------------------------------------- | -------------------------------- |
| Rules that must apply on turn 0 (every turn, every session) | `$AGENT_HOME/MEMORY.md` (this skill) |
| Durable facts, decisions, history, code excerpts            | MemPalace drawers (`mempalace_add_drawer`) |
| Recall a past decision, error, or design choice             | `mempalace_search`               |
| Entity relationships (who owns what, dependencies, timing)  | `mempalace_kg_query`             |
| Raw timeline of events                                      | MemPalace `mempalace_diary_write` (AAAK) |

If a piece of information does not need to be in context **every** turn, it
does NOT belong in `MEMORY.md`. File it in the palace instead.

## The one remaining layer — `MEMORY.md`

Path: `$AGENT_HOME/MEMORY.md`

- **Cap: ~150 lines.** Every line costs tokens on every turn. Treat this as a
  budget, not an aspiration.
- **Turn-0 rules only.** Operating constraints, hard "always/never" rules, and
  pointers the agent needs before it can act. Not facts, not history, not logs.
- **No daily notes.** If you catch yourself writing a dated event, stop — that
  is a MemPalace drawer, not a `MEMORY.md` entry.
- **No entity knowledge graph.** Atomic facts about people, projects, or
  companies go in the palace as drawers with verbatim content.

Rule of thumb: if removing a line from `MEMORY.md` would not cause the agent to
make a wrong call on its very first action, the line should not be there.

## Memory Recall — search MemPalace first

`qmd` is no longer required. For any cross-cutting recall question — "how does
X work", "why did we choose Y", "did we hit this error before", "who owns Z" —
use MemPalace as the first layer:

```text
mempalace_search        # semantic search across drawers, returns the WHY + WHERE
mempalace_kg_query      # entity relationships, ownership, dependencies, timelines
mempalace_kg_timeline   # when did this happen / what changed in this entity
mempalace_get_drawer    # full content of a known drawer
```

Filing is just as important as searching. When you solve a non-obvious bug,
make an architecture trade-off, or learn a hidden constraint, call
`mempalace_add_drawer` with VERBATIM content (error messages, decisions,
quotes) — do not summarise. The palace's WHY is what makes future recall useful.

## Planning

Keep plans where the user / board / other agents can see them — issue
documents on the relevant Paperclip issue (key `plan`), not in personal memory.
The `paperclip` skill covers the plan-document workflow.

## What was retired and why

- **Layer 1 (`life/` PARA tree with `summary.md` + `items.yaml`)** — superseded
  by MemPalace drawers and the knowledge graph. Atomic facts now live in
  drawers with semantic search instead of folder-scoped YAML.
- **Layer 2 (`memory/YYYY-MM-DD.md` daily notes)** — superseded by
  `mempalace_diary_write` (AAAK dialect) at session end, which is searchable
  and timeline-queryable.
- **`qmd` recall** — superseded by `mempalace_search` /
  `mempalace_kg_query`, which return the WHY alongside the WHERE.

Existing `life/` and `memory/` trees from older agents are read-only history.
Do not write new content into them; migrate anything still useful into the
palace and leave the old files as-is.

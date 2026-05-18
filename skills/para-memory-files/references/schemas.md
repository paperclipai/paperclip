# MEMORY.md Curation

> The PARA `life/items.yaml` knowledge graph and its atomic-fact schema have
> been retired. Atomic facts now live as MemPalace drawers, not as YAML rows in
> a personal folder. The schema and access-tracking metadata below described
> that retired system and no longer apply.
>
> This file now covers only one thing: how to keep `MEMORY.md` small and
> useful, since it is the single remaining file-memory surface.

## What `MEMORY.md` is for

`MEMORY.md` is a tiny, always-loaded file at `$AGENT_HOME/MEMORY.md`. Every
line in it costs prompt tokens on every turn of every session. Use it ONLY for
rules and pointers the agent needs before its first tool call — never for
facts, history, or logs (those go in the MemPalace).

## Curation rules

- **Hard cap: ~150 lines.** When the file approaches this size, prune before
  adding.
- **Turn-0 test.** For each line, ask: "If this line were missing, would the
  agent make a wrong call on its very first action this session?" If no,
  delete the line.
- **No dated entries.** Daily events, run logs, and conversation summaries
  belong in `mempalace_diary_write`, not here.
- **No relationship trees.** "X owns Y", "A depends on B", "person P works on
  project Q" are knowledge-graph facts — file them with `mempalace_kg_add`.
- **No code excerpts.** Verbatim code, error messages, and decision context go
  in MemPalace drawers via `mempalace_add_drawer`.
- **No "might be useful someday" entries.** If you cannot name the very next
  decision a line will inform, it does not earn the per-turn token cost.

## When you outgrow the cap

If `MEMORY.md` keeps trying to grow past ~150 lines, that is a signal that
content is in the wrong layer — not that the cap is wrong. Walk the file and
move each oversized entry to its proper home:

| Found in `MEMORY.md`                  | Move to                              |
| ------------------------------------- | ------------------------------------ |
| Dated events, "what happened today"   | `mempalace_diary_write`              |
| "Why we chose X over Y" decisions     | `mempalace_add_drawer` (decisions room) |
| Atomic facts about people / projects  | `mempalace_kg_add`                   |
| Long code snippets or error traces    | `mempalace_add_drawer`               |
| Pointers ("see file Z") with no rule  | Delete — the agent can search        |

## What this file used to contain

For historical context: earlier versions of this skill described an atomic
fact YAML schema (`items.yaml`) with `id`, `category`, `timestamp`, `status`,
`superseded_by`, `last_accessed`, and `access_count` fields, plus a
hot/warm/cold decay model for rewriting per-entity `summary.md` files weekly.
That entire system has been replaced by MemPalace drawers + semantic search;
no decay model is needed because the palace ranks by relevance at query time.
Existing `life/` trees from older agents are read-only history — do not write
new YAML facts there.

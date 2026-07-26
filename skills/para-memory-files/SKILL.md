---
name: para-memory-files
description: >
  File-based memory system using Tiago Forte's PARA method. "Use when storing,
  retrieving, updating, or organizing knowledge across sessions" — e.g.
  "remember this", "what do we know about <person/company>?", "write today's
  notes", "run weekly synthesis". Covers the knowledge graph in PARA folders,
  daily notes, tacit knowledge, memory decay, and recall via qmd.
---

# PARA Memory Files

Persistent, file-based memory organized by Tiago Forte's PARA method. All paths are relative to `$AGENT_HOME`.

## Three Memory Layers

1. **Knowledge graph** (`$AGENT_HOME/life/` — PARA): entity folders, each with `summary.md` (quick context, load first) and `items.yaml` (atomic facts, load on demand).
2. **Daily notes** (`$AGENT_HOME/memory/YYYY-MM-DD.md`): raw timeline — the "when" layer. Write continuously during conversations; extract durable facts to Layer 1 during heartbeats.
3. **Tacit knowledge** (`$AGENT_HOME/MEMORY.md`): how the user operates — patterns, preferences, lessons. Not facts about the world; facts about the user. Update whenever you learn new operating patterns.

## References

- `references/storage-rules.md` — PARA folder rules, fact rules (supersede, never delete), entity-creation criteria, archiving, and qmd recall commands. Read before writing to or searching memory.
- `references/schemas.md` — atomic fact YAML schema and memory decay rules.

## Write It Down — No Mental Notes

Memory does not survive session restarts. Files do.

- Want to remember something → WRITE IT TO A FILE.
- "Remember this" → update `$AGENT_HOME/memory/YYYY-MM-DD.md` or the relevant entity file.
- Learn a lesson → update AGENTS.md, TOOLS.md, or the relevant skill file.
- Make a mistake → document it so future-you does not repeat it.

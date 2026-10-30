# LLM Wiki Maintainer Skills

This folder is the plugin-level source for LLM Wiki managed company skills. Paperclip installs these skills into the company skill library and syncs them onto the Wiki Maintainer agent. The Wiki Maintainer's identity and operating loop live in `agents/wiki-maintainer/AGENTS.md`; the wiki-root `AGENTS.md` remains the wiki schema for page layout, citation style, and log format.

Each skill is an isolated SKILL.md describing one job — when to invoke it, the inputs that must be true before starting, the steps, and the durable output the operation must leave behind.

## Skill registry

| Skill | When to invoke |
|---|---|
| [`wiki-maintainer`](./wiki-maintainer/SKILL.md) | General LLM Wiki maintenance and tool-use guidance shared by the operation skills. |
| [`wiki-ingest`](./wiki-ingest/SKILL.md) | A new file landed in `raw/` and the operation issue says "ingest" — turn the source into durable wiki pages. |
| [`wiki-query`](./wiki-query/SKILL.md) | The user asked the wiki a question; answer with citations and offer to file durable synthesis back into `wiki/`. |
| [`wiki-lint`](./wiki-lint/SKILL.md) | A lint or health-check operation — audit for contradictions, orphan pages, weak provenance, broken links, missing concept pages. |
| [`paperclip-distill`](./paperclip-distill/SKILL.md) | Cursor-window, distill, or backfill operation on Paperclip activity — write a wiki-insightful project page, decisions log, and history note. |
| [`index-refresh`](./index-refresh/SKILL.md) | Refresh `wiki/index.md` so each entry has a tight, scannable summary; flag drift between the index and recent log activity. |

## Layering

```
AGENTS.md (wiki root)                              ← schema for the wiki itself: page conventions, frontmatter, voice
  agents/wiki-maintainer/AGENTS.md                 ← agent identity and operating loop
  skills/<skill>/SKILL.md                          ← plugin-managed company skills installed onto the maintainer
```

When a skill conflicts with the wiki-root `AGENTS.md`, the wiki schema wins for page format/voice and the skill wins for operation flow. When a skill conflicts with the agent's `AGENTS.md`, the agent file wins for identity and the skill wins for the operation procedure.

## Skill conventions

- Front matter has `name` (kebab-case) and `description` (one or two sentences with the trigger condition).
- Each skill names the input it expects (e.g. an operation issue with `originKind` ending in `:ingest`, a captured `raw/` path, a Paperclip source bundle).
- Each skill ends with a verification checklist — what must be true before the operation issue is closed `done`.
- Skills cite the wiki-plugin tools they rely on (`wiki_search`, `wiki_read_page`, `wiki_write_page`, `wiki_read_source`, `wiki_list_sources`).
- Skills do not duplicate the page conventions from the wiki root `AGENTS.md`. They reference it instead.

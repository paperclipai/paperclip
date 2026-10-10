# AGENTS.md — LLM Wiki Schema

You are the maintainer of this personal wiki. The wiki is a persistent, interlinked knowledge base built from raw source documents. You read sources, extract knowledge, and integrate it into evolving wiki pages. The user curates sources, directs analysis, and asks questions; you handle the bookkeeping.

The underlying pattern is described in `IDEA.md` (Karpathy's "LLM Wiki" gist). Read it if you need the philosophy; this file is the operational schema.

## Layout

```
.
├── AGENTS.md         # this file — your operating instructions
├── IDEA.md           # the pattern this wiki follows
├── raw/              # immutable source documents (you read, never write)
└── wiki/             # generated, owned by you
    ├── index.md      # catalog of all pages
    ├── log.md        # append-only timeline of operations
    ├── sources/      # one summary page per source
    ├── projects/     # Paperclip project overviews, standups, decisions, and history
    │   └── <slug>/
    │       ├── index.md
    │       ├── standup.md
    │       ├── decisions.md
    │       └── history.md
    ├── entities/     # people, organizations, products, places
    ├── concepts/     # ideas, frameworks, definitions
    └── synthesis/    # cross-cutting analysis, comparisons, theses
```

The subdirectories under `wiki/` are conventional, not enforced. Add new categories (e.g. `wiki/papers/`) as the domain demands — and update this file when you do.

Paperclip project material lives only under `wiki/projects/<project-slug>/`. Do not create a top-level `projects/` directory.

- `wiki/projects/<project-slug>/standup.md` is the executive-level project standup. It answers where the project stands today, what changed recently, current blockers/risks, and the next concrete actions.
- `wiki/projects/<project-slug>/index.md` is the durable knowledge page. It explains what the project is, why it exists, decisions made, history, and long-lived context.
- Keep the two linked. A standup should link to the durable project page, and the durable project page should point at the current standup for live status.
- Update `standup.md` whenever Paperclip project, issue, plan, comment, blocker, approval, or status history materially changes the project's current state. Do not append endless dated sections; rewrite it as today's concise status.
- Project writing should be editorial and concept-grouped. Do not dump issue queues, UUIDs, raw metadata, or date-heavy ledgers into project pages. Reference Paperclip tasks with human issue links where useful, but make headings and paragraphs explain the concepts, decisions, completed work, next work, and blockers in plain executive language.

## Page conventions

- **Filename:** kebab-case, `.md`. Treat filenames as stable; do not rename without updating backlinks.
- **Frontmatter:** YAML at the top of every wiki page.
  ```yaml
  ---
  title: Human-readable title
  type: source | project | entity | concept | synthesis
  tags: [tag-a, tag-b]
  sources: [raw/doc.pdf]    # for source pages and synthesis pages
  created: YYYY-MM-DD
  updated: YYYY-MM-DD
  ---
  ```
- **Cross-links:** Obsidian-style `[[wiki/entities/some-page]]` (or `[[some-page]]` when unambiguous). When you mention a concept or entity that has — or should have — its own page, link it.
- **Citations:** cite the source inline whenever a claim comes from one: `(see [[wiki/sources/some-slug]])`.
- **Voice:** terse, factual, neutral. The wiki is reference material, not narrative.

## Operations

### Ingest

Triggered when the user drops a file in `raw/` and asks to process it (or just says "ingest").

1. Read the source end to end.
2. Briefly discuss key takeaways with the user before writing — confirm what to emphasize.
3. Create `wiki/sources/<slug>.md`: a summary page (~300–800 words) covering the source's main claims, structure, and notable quotes or data.
4. Update or create relevant pages in `entities/`, `concepts/`, `synthesis/`. A typical ingest touches 5–15 pages.
5. Add any new pages to `wiki/index.md`.
6. Append a log entry:
   ```
   ## [YYYY-MM-DD] ingest | <source title>
   - source: raw/<filename>
   - new pages: [[...]], [[...]]
   - updated pages: [[...]], [[...]]
   - notes: <one-line synthesis, contradiction flagged, or open question>
   ```

When new information contradicts an existing page, do **not** silently overwrite. Flag the contradiction on the page (a `> ⚠ contradicted by [[...]] (YYYY-MM-DD)` callout) and note it in the log.

### Project updates

Triggered when Paperclip project, issue, plan, comment, blocker, or status history is distilled into the wiki.

1. Create or update `wiki/projects/<project-slug>/standup.md` first. Every Paperclip project represented in the wiki must have one. Keep stable sections for executive readout, what changed, decisions, blockers/risks, next actions, and links.
2. Create or update `wiki/projects/<project-slug>/index.md` as the durable project overview. Keep stable sections for overview, current direction, workstreams, decisions, open risks/blockers, and references.
3. Use `wiki/projects/<project-slug>/decisions.md` for accepted/rejected plans, architectural decisions, approval outcomes, and reversals when a project has enough decision history to warrant a separate page.
4. Use `wiki/projects/<project-slug>/history.md` for compact narrative history of meaningful project movement. Group by phase or concept; do not mirror every issue comment.
5. Always cite Paperclip source material with readable links to issue identifiers, document keys, issue documents, approvals, and raw/source pages. Do not put UUIDs in prose unless the UUID itself is the subject.
6. Update `wiki/index.md` under Projects and append a `project` log entry to `wiki/log.md`.

### Query

The user asks a question. You:

1. Read `wiki/index.md` to find candidate pages.
2. Read those pages; follow links as needed.
3. Answer with citations back to wiki pages, and ultimately to raw sources.
4. If the answer is substantial (a comparison, analysis, new synthesis), offer to file it under `wiki/synthesis/` so the work compounds rather than disappearing into chat history.

If the wiki lacks what the question needs, say so plainly and suggest sources to ingest or web searches to run.

### Lint

On request ("lint", "health check"), scan for:

- contradictions across pages
- claims a newer source has superseded
- orphan pages (not linked from `index.md` or any other page)
- concepts mentioned in multiple places but lacking a dedicated page
- broken `[[wiki-links]]`
- gaps where a web search or new source would help

Report findings as a checklist and ask the user which to act on.

## index.md format

A catalog organized by category. Each line: `- [[path]] — one-line summary`. Keep it scannable; this is your primary navigation aid before opening pages.

## log.md format

Append new entries to the bottom. Every entry header follows:

```
## [YYYY-MM-DD] <op> | <subject>
```

so `grep "^## \[" wiki/log.md | tail -10` always returns recent activity. Operations: `ingest`, `query`, `lint`, `setup`, `refactor`.

## Customization

This schema is intentionally generic. As the wiki's domain becomes clear, evolve it:

- add domain-specific page types and subdirectories
- adjust frontmatter fields
- specify preferred output formats for queries (Marp slides, charts, tables)
- record workflow preferences (one-at-a-time vs batch ingest, level of human supervision)

When you and the user agree on a convention, **write it into this file**. The schema is the wiki's source of truth for how the wiki is built.

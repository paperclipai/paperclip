# LLM-Wiki Schema & Conventions

> An [[llm-wiki]] in the Andrej Karpathy pattern: a persistent, compounding knowledge base that an LLM
> agent builds and maintains from immutable sources, so knowledge accumulates instead of evaporating
> between sessions. This wiki captures the Paperclip idea-and-research corpus for **human review**.
> (Pattern: <https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f>)

## Layout

```
.ideas/llm-wiki/
├── CLAUDE.md          # this file — schema, conventions, workflows
├── index.md           # content catalog: every wiki page + one-line summary, by category
├── log.md             # append-only chronological record of ingest/query/lint passes
├── raw/               # IMMUTABLE sources — read, never edit. The ground truth.
│   ├── MANIFEST.md    # what the sources are + where they live
│   └── research-sources.md   # consolidated external bibliography (web + arXiv)
└── wiki/              # LLM-compiled concept pages — one concept per file, fully owned by the LLM
```

The **sources** (the 66 idea files `../0*.md`, the `../combinations/`, `../_skeleton-reference.md`, and
`../../../Documents/Aisha/PAPERCLIP_INTEGRATION.md`) are treated as immutable ground truth and are
catalogued in `raw/MANIFEST.md` rather than copied.

## Page conventions (`wiki/*.md`)

- **One concept per file.** Pages are *concept/entity syntheses*, not copies of individual ideas — each
  page pulls together everything the corpus says about one topic.
- **YAML frontmatter** on every page:
  ```yaml
  ---
  title: Human-Readable Title
  type: concept | entity | synthesis | comparison
  status: draft | reviewed
  sources: [001, 002, combo-01, xcombo-03, _skeleton-reference, research-sources]
  updated: 2026-06-24
  ---
  ```
- **`[[wikilinks]]`** for every cross-reference to another wiki page (by filename slug, no extension).
- **Provenance.** Every claim traces back to a source via its id (idea number, combo name, or a
  `research-sources` anchor). End each page with a `## Provenance` block listing the source ids.
- **Human-review affordances.** Each page ends with `## Open questions for human review` — the decisions
  or uncertainties a human should weigh in on. This wiki exists to be reviewed.

## Workflows

- **Ingest** (add a source): read it, write/refresh the relevant concept page(s) in `wiki/`, add or update
  `[[wikilinks]]`, update `index.md`, append a dated entry to `log.md`. One source typically touches
  several concept pages.
- **Query** (answer a question): synthesize from `wiki/` + `index.md` with citations; if the answer is
  durable, file it back as a new/expanded page.
- **Lint** (maintain health): scan for contradictions, stale claims, orphan pages (no inbound links), and
  concepts mentioned but missing a page; record findings in `log.md`.

## Division of labor

- **Human owns:** source curation, direction, high-level questions, and *reviewing the synthesis*.
- **LLM owns:** summarization, cross-referencing, file bookkeeping, consistency, contradiction-flagging,
  and keeping `index.md`/`log.md` current.

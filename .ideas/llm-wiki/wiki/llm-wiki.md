---
title: The LLM-Wiki Pattern
type: concept
status: reviewed
sources: [research-sources, _skeleton-reference]
updated: 2026-06-24
---

# The LLM-Wiki Pattern

A **persistent, compounding knowledge base an LLM builds and maintains** from immutable sources — so
knowledge *accumulates* across sessions instead of being re-derived each time (the failure mode of plain
RAG). Proposed by Andrej Karpathy (`raw/research-sources.md#llm-wiki`).

## Core shift: stateful, compiled knowledge vs. stateless retrieval

- **RAG** retrieves raw chunks at query time and re-synthesizes an answer from scratch every time — no
  accumulation; multi-document synthesis is re-done on every question.
- **LLM-wiki** *compiles* sources once into human-readable concept pages, then *keeps them current*. The
  cross-references already exist; contradictions are already flagged. Explorations file back as new pages.

## Three layers

1. **`raw/`** — immutable sources (the [[paperclip-architecture-skeleton|codebase]], the 66 ideas, the
   combinations, external research). Read, never edited.
2. **`wiki/`** — LLM-owned concept pages: one concept/file, YAML frontmatter, `[[wikilinks]]`, provenance.
3. **Schema (`CLAUDE.md`) + `index.md` + `log.md`** — conventions, catalog, and append-only history.

## Why it fits this corpus

This very wiki applies the pattern to the Paperclip idea/research corpus to produce **knowledge for human
review**. It also recurs *inside* the product as a feature: [[knowledge-and-memory]] proposes bundling an
llm-wiki engine as Paperclip's default knowledge provider (idea 060), and the
[[code-knowledge-flywheel]] applies it to code.

## Provenance

- `raw/research-sources.md` → `[llm-wiki]` (Karpathy gist, VentureBeat, Level Up Coding).
- Internal echoes: idea 060 ([[knowledge-and-memory]]), the code-knowledge flywheel combination.

## Open questions for human review

- Should the in-product knowledge system (idea 060) and *this* meta-wiki share one engine/format?
- How aggressively should the lint pass auto-resolve contradictions vs. flag for a human?

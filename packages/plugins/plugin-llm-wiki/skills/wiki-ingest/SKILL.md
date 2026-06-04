---
name: wiki-ingest
description: Use when an operation issue asks you to ingest a captured source from `raw/` into the LLM Wiki, or when the user explicitly says "ingest <slug>". The issue body will name a file under `raw/` (e.g. `raw/karpathy-llm-wiki.md`) and ask for durable wiki pages. Do not invoke this skill for Paperclip activity bundles — those use `paperclip-distill` instead.
---

# Wiki Ingest

Turn one source document into durable, interlinked wiki knowledge.

## Inputs

- An operation issue with `operationType: "ingest"` assigned to you.
- A `raw/` path mentioned in the issue body (always treat `raw/` as immutable).
- The operation issue's target `wikiId`, `spaceSlug`, and space root (otherwise stop and surface the missing config to the requester).

## Workflow

1. **Read context first.**
   - Read the target space's `AGENTS.md` for page conventions (filenames, frontmatter, voice, citation style).
   - Read the target space's `wiki/index.md` to see what already exists.
   - Read the target space's last ~20 entries of `wiki/log.md` to avoid re-ingesting a source or re-resolving a contradiction someone else already filed.
2. **Read the source end to end** with `wiki_read_source`, passing the operation issue's `wikiId` and `spaceSlug`. Do not skim. Note the source's structure, claims, dates, and anything that contradicts existing pages.
3. **Plan, then confirm — but only if the user is in the loop.** If the operation came from a routine (no live user), proceed. If a user is asking interactively, summarise the 3–5 takeaways you intend to file and ask which to emphasise before writing.
4. **Write the source page** at `wiki/sources/<slug>.md` — ~300–800 words, frontmatter per the wiki schema, neutral voice, key claims with quoted excerpts where they carry weight. The source page is the canonical citation target for everything else this skill writes.
5. **Update or create downstream pages** in `entities/`, `concepts/`, and `synthesis/`. A typical ingest touches 5–15 pages; resist creating pages for ideas that only appear once.
6. **Wire the cross-links.** Every claim that comes from the source cites it as `(see [[wiki/sources/<slug>]])`. Every entity / concept mentioned by name on more than one page links to its dedicated page.
7. **Flag contradictions; do not silently overwrite.** When new material disagrees with an existing page, append a `> ⚠ contradicted by [[wiki/sources/<slug>]] (YYYY-MM-DD)` callout to the older page and note the conflict in the log.
8. **Refresh `wiki/index.md`** with one-line summaries for any new pages.
9. **Append a log entry** in `wiki/log.md`:
   ```
   ## [YYYY-MM-DD] ingest | <source title>
   - source: raw/<filename>
   - new pages: [[...]], [[...]]
   - updated pages: [[...]], [[...]]
   - notes: <one-line synthesis or open question>
   ```

## Voice

- Terse, factual, neutral. Reference material, not narrative.
- No "Today I learned" or "This is interesting because" framing.
- Quote the source verbatim when paraphrasing would lose precision.

## Verification

Before closing the operation issue:

- [ ] Source page exists at `wiki/sources/<slug>.md` with valid frontmatter and a `sources:` field pointing to the raw path.
- [ ] Every new or updated page links back to the source page or a downstream page that does.
- [ ] `wiki/index.md` lists every new page under the right category with a one-line summary.
- [ ] `wiki/log.md` has the ingest entry with the exact filename heading format (so `grep "^## \[" wiki/log.md` keeps working).
- [ ] Any contradiction between the new source and an older page is annotated, not silently overwritten.
- [ ] No file under `raw/` was modified.

## Tools

`wiki_list_sources`, `wiki_read_source`, `wiki_search`, `wiki_read_page`, `wiki_write_page`. Always include the operation issue's `wikiId` and `spaceSlug`.

---
name: wiki-query
description: Use when an operation issue asks you to answer a question from the LLM Wiki — `operationType: "query"` and a question in the issue body. Answer with citations to wiki pages and raw sources, and offer to file durable synthesis back into `wiki/synthesis/` so the work compounds instead of disappearing into a chat thread.
---

# Wiki Query

Answer a question from what the wiki actually contains, with citations.

## Inputs

- An operation issue with `operationType: "query"` and the question in the body.
- The operation issue's target `wikiId`, `spaceSlug`, and space root.

## Workflow

1. **Open the target space's `wiki/index.md` first** — it is the navigation aid. Identify candidate pages.
2. **Read the candidate pages** end to end with `wiki_read_page`, always passing the operation issue's `wikiId` and `spaceSlug`. Follow `[[wiki-links]]` to neighbouring pages when the question spans entities or concepts.
3. **Inspect raw sources** when a wiki page's claim feels thin. The wiki points to `raw/` precisely so you can verify before answering. Use `wiki_read_source`.
4. **Answer the question** in the operation issue thread. Structure:
   - Direct answer first, in 1–4 sentences.
   - Then the supporting facts as bullet points, each with an inline citation: `(see [[wiki/concepts/managed-resources]])` or `(see raw/<filename>)`.
   - If you needed to read a raw source the wiki did not summarise, name that as a gap.
5. **Decide whether the answer is durable.** If the question forced you to do real synthesis (a comparison, a tradeoff, a definition of something that isn't already a page), offer to file it under `wiki/synthesis/<slug>.md`. Do not write the synthesis page silently — it is opt-in. If the user accepts, write the page, link it from `wiki/index.md`, and append a `query | filed synthesis` log entry.
6. **When the wiki cannot answer**, say so plainly. Suggest a source the user should ingest, a Paperclip project that would help if distilled, or a web lookup. Never bluff.

## Voice

- Lead with the answer.
- Cite as you go, not in a footnote block at the end.
- Use the wiki's terse, factual voice. The query response is itself a candidate for filing into `wiki/synthesis/`.

## Verification

Before closing the operation issue:

- [ ] Every claim in the answer cites a wiki page or raw source.
- [ ] If the wiki was insufficient, that is stated directly with a concrete next step (ingest source X, distill project Y, web search Z).
- [ ] If you wrote a synthesis page, `wiki/index.md` lists it and `wiki/log.md` has a `query | filed synthesis` entry.
- [ ] No file under `raw/` was modified.

## Tools

`wiki_search`, `wiki_read_page`, `wiki_list_sources`, `wiki_read_source`, `wiki_write_page` (only when filing synthesis). Always include the operation issue's `wikiId` and `spaceSlug`.

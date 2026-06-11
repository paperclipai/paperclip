---
name: docs-lookup
description: >-
  Look up Paperclip's user-facing documentation (the published `docs/` corpus:
  start, api, cli, deploy, board-operator + agent-developer guides, adapters,
  companies, specs) without loading it all into context. Use when answering a
  question about how Paperclip works for users/operators/deployers, finding the
  right API/CLI/deploy/adapter doc, or before editing anything under `docs/`.
  Routes via a generated index to the one file you need.
---

# docs-lookup

A corpus of **66 files** lives under `dataDir` (recorded in `index.json`). It is
too large to read whole. Use the router instead of opening files blindly.

## Files

| File | When to read |
|------|-------------|
| `index.json` | **First.** Router: `aliasIndex` (keyword → file) + `entries` (per-file title, aliases, sections, summary). |
| `detail-index.json` | On demand. Heavy map: section heading → file. Use when `aliasIndex` doesn't resolve the topic. |
| `<dataDir>/<file>` | The actual content. Read **one at a time**, never the whole folder. |

## Lookup protocol

1. **Read `index.json`.**
2. **Resolve to exactly one file:**
   - Normalize the user's request to lowercase words and match against `aliasIndex`.
   - Need a specific section/topic, not a whole doc? Read `detail-index.json` and match the section heading → file.
   - Still ambiguous? Scan `entries` and pick by `title`/`summary`/aliases.
3. **Read that one file** under `dataDir`.
4. If it points you to another file you also need, repeat from step 2 — **one file per need**.

## Rules

- Never read more than a couple of files for a single question.
- If nothing matches, say so and list the 3 closest entries. Do **not** invent content.
- The index is generated from the data — if it looks stale, run
  `node scripts/build-index.cjs`, never hand-edit it.

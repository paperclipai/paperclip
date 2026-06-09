---
name: wiki-lint
description: Use when an operation issue is a lint or health-check (`operationType: "lint"`) — typically the nightly lint routine or a manual "Run lint" from the UI. Audit the wiki for contradictions, orphans, weak provenance, broken links, and missing concept pages, and return a triage list — do not auto-fix.
---

# Wiki Lint

Audit, do not edit. Return findings the maintainer (human or agent) can triage.

## Inputs

- An operation issue with `operationType: "lint"`.
- The operation issue's target `wikiId`, `spaceSlug`, and space root. Lint only that space unless the issue explicitly says this is a multi-space sweep.

## Workflow

1. **Walk the target space's `wiki/index.md` and wiki tree** with `wiki_search` and `wiki_read_page`, always passing the operation issue's `wikiId` and `spaceSlug`. Build a mental map of: pages that exist, pages referenced from `index.md`, pages referenced from other pages, and raw sources.
2. **Check for the seven recurring issues**, in this order:
   1. **Contradictions** — two pages making incompatible claims about the same entity, decision, or status. Flag both pages, name the conflicting claims, and quote evidence.
   2. **Stale claims** — a page asserts X, but a newer source under `raw/` has superseded it. Flag the older page; never overwrite.
   3. **Orphan pages** — a `wiki/` page is not linked from `index.md` and not referenced from any other wiki page. Either it should be linked, removed, or merged.
   4. **Concept gaps** — a term appears on three or more pages but has no dedicated `wiki/concepts/<slug>.md`. Recommend creating one.
   5. **Broken `[[wiki-links]]`** — a link target file does not exist.
   6. **Weak provenance** — a non-trivial claim is uncited or cites only the wiki itself in a circle. The original source ref should be findable.
   7. **Index / log drift** — pages exist that are not in `index.md`, or `index.md` lists pages that no longer exist. Recent operations in `wiki/log.md` that did not produce a corresponding page change.
3. **Return a triage list**, grouped by severity:
   - **critical**: contradictions, broken links to active pages, fabricated citations.
   - **medium**: stale claims, weak provenance, large concept gaps.
   - **low**: orphans, log drift, small index gaps.
   Each item has: file path, evidence (a 1–2 line quote), suggested fix, and the operation that should follow up (`ingest`, `paperclip-distill`, `index-refresh`, manual review).
4. **Do not write to `wiki/`.** Lint is read-only by design — the maintainer or the routine that follows decides which findings to act on.
5. **Append a log entry** describing the run:
   ```
   ## [YYYY-MM-DD] lint | <N findings, M critical>
   - operation issue: <issue identifier>
   - critical: <count>
   - medium: <count>
   - low: <count>
   ```

## Voice

- Lead with the count by severity.
- Each finding is one bullet. Resist commentary.
- When in doubt about severity, say so and surface it as medium with a "verify" note.

## Verification

Before closing the operation issue:

- [ ] Findings are grouped by severity with file paths, evidence, and suggested fix per item.
- [ ] No files under `raw/` were modified. No files under `wiki/` were modified except `wiki/log.md`.
- [ ] If the run found nothing, the issue is closed with "no findings" and the log entry still exists so future audits can see this run happened.

## Tools

`wiki_search`, `wiki_read_page`, `wiki_list_sources`, `wiki_read_source`, `wiki_write_page` (only `wiki/log.md`). Always include the operation issue's `wikiId` and `spaceSlug`.

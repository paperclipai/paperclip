---
name: docx-tracked-changes
description: Apply edits to a .docx file as tracked changes (Word's Track Changes feature) so a counterparty receives a redline they can accept/reject. Used by redliner specialists. Includes resolve/accept/reject operations.
tools: [read, write]
inputs:
  - source_docx_path: string
  - edits: object[]                # each: { kind, anchor, old_text?, new_text?, comment? }
  - author_name: string
  - author_initials: string
outputs:
  - output_docx_path: string
  - applied_change_ids: string[]
  - skipped_edits: object[]
  - errors: object[]
---

# DOCX Tracked Changes

You convert a list of edits into Word-compatible tracked changes inside a .docx file. The output is a single .docx that the counterparty opens; their Word client shows insertions, deletions, and comments authored by `author_name`.

## Edit kinds

- **insertion** — insert new_text at anchor.
- **deletion** — delete old_text at anchor.
- **replacement** — delete old_text + insert new_text at anchor.
- **comment** — attach a comment at anchor (no text change).
- **resolve_existing** — accept or reject a tracked change already in the document, identified by its change_id.

## Anchor resolution

An anchor identifies *where* in the document the edit goes. Anchors can be:
- An exact text match (`anchor: { text: "shall be governed by the laws of New York" }`) — first occurrence by default; `nth` parameter to select a later occurrence.
- A clause path (`anchor: { clause: "Section 10.2(a)" }`) — requires the document to have a numbered clause structure.
- A paragraph index (`anchor: { paragraph_index: 47 }`) — fallback.

## Procedure

1. Load the source .docx (must be a real .docx; .doc is not supported — convert first).
2. Resolve every anchor. Any unresolvable anchor goes to `skipped_edits` with a reason; the rest proceed.
3. For each resolved edit, write the corresponding `<w:ins>`, `<w:del>`, or `<w:commentReference>` element with the author/initials/timestamp on each.
4. Preserve all existing tracked changes (do not flatten the doc).
5. Output a new .docx at `output_docx_path`.

## Hard rules

- Never silently rewrite a paragraph. Every change must be a discrete `<w:ins>` or `<w:del>` so the counterparty can accept/reject granularly.
- Never strip existing tracked changes from the source.
- Never change formatting (fonts, styles, numbering) — formatting changes are out of scope of this skill.
- Author name + initials must be the firm/department's redline persona, not a personal name (use "Odysseus / [Firm Name]" by convention).

## Output schema

```yaml
output_docx_path: <path>
applied_change_ids: [<id>, ...]
skipped_edits:
  - edit_index: <n>
    anchor: <anchor>
    reason: <one line>
errors:
  - edit_index: <n>
    error: <one line>
```

## Reference implementation

Lifted from [willchen96/mike](https://github.com/willchen96/mike) `backend/src/lib/docxTrackedChanges.ts` — exports `extractDocxBodyText`, `extractTrackedChangeIds`, `applyTrackedEdits`, `resolveTrackedChange`. Pattern adapted; this skill specifies the contract, the forked-odysseus server provides the implementation.

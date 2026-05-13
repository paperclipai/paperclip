---
name: docx-generation
description: Generate structured Word documents (and optionally XLSX) from a section tree — headings, paragraphs, tables, bullets. Supports landscape orientation, table-only sections (e.g., CP checklists), and citation footers. Used by specialists that need to deliver a downloadable artifact rather than an inline response.
tools: [read, write]
inputs:
  - title: string
  - landscape: boolean             # default false
  - sections: object[]             # each: { heading, content?, table?, bullets? }
  - footer_citations: object[]?
  - output_path: string
outputs:
  - output_path: string
  - page_count: number
  - table_count: number
---

# DOCX Generation

You build clean, structured Word documents from a sections array. The shape is intentionally narrow: heading + (content paragraph OR table OR bulleted list) per section. No deep nesting.

## Section shape

```yaml
sections:
  - heading: "1. Corporate Conditions"
    table:
      headers: ["Index", "Clause Number", "Clause", "Status"]
      rows:
        - ["1", "2.1", "Certified copies of constitutional documents", ""]
        - ["2", "2.2", "Board resolution authorising the financing", ""]
  - heading: "2. Financial Conditions"
    table:
      headers: ["Index", "Clause Number", "Clause", "Status"]
      rows: [...]
  - heading: "3. Notes"
    content: "All conditions to be satisfied no later than 5 business days prior to drawdown."
```

## Procedure

1. Validate `sections`. Each must have exactly one of `content`, `table`, or `bullets` (in addition to the heading).
2. For table sections, every row must have the same length as `headers`. If a row is short, pad with empty strings; if long, return an error.
3. Apply landscape orientation if `landscape=true` — typically for checklists and tabular reports.
4. Insert citation footnotes if `footer_citations` is provided. Format: `[citation_id] <quoted excerpt> — <source>`.
5. Write the .docx to `output_path`.

## Conventions (per Odysseus house style)

- Body font: Calibri 11.
- Heading 1: Calibri 14 bold.
- Tables: gridded, header row shaded light gray.
- Page margins: 0.75" all sides; 0.5" left/right when landscape.
- Page number in footer (right-aligned).
- File name pattern: `<matter_id>-<artifact_kind>-v<n>.docx`.

## Hard rules

- Never produce a .docx with mismatched table row lengths — Word will render but the structure is broken.
- Never include placeholder text like "Lorem ipsum" or "TODO" in the final output. If a value is missing, leave the cell empty (empty string).
- Never embed external images without explicit input — privilege/confidentiality risk.
- Always set the document's author metadata to the firm/department's redline persona, never to an individual.

## Output schema

```yaml
output_path: <path>
page_count: <n>
table_count: <n>
```

## Reference implementation

Lifted from [willchen96/mike](https://github.com/willchen96/mike) — the `generate_docx` tool in `backend/src/lib/chatTools.ts` supports headings, tables, and landscape orientation. This skill specifies the contract; the forked-paperclip server implements it.

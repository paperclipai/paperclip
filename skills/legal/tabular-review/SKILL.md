---
name: tabular-review
description: Use to run a multi-document review where the output is a table — rows are documents, columns are extraction queries (parties, governing law, term, termination, etc.). Each column can be a preset (loaded from `clause-extraction-presets`) or a custom query with a chosen output format (text, bulleted_list, date, yes_no, number). Cell values must include citations to the source document.
tools: [skill.invoke, read, grep, mcp.invoke]
inputs:
  - documents: file[]               # the N documents under review
  - columns: object[]               # each: { name, prompt, format, preset? }
  - require_citations: boolean      # default true
  - export_format: markdown | xlsx  # default markdown; xlsx via docx-generation
outputs:
  - table: object                   # headers + rows
  - citations: object               # cell-id -> [{doc, page_or_section, quote}]
  - unanswered_cells: string[]
  - export_path: string?
---

# Tabular Review

You orchestrate a multi-document tabular review. Each row = one document; each column = one structured extraction query. This is the workhorse skill for diligence, contract intake batches, vendor reviews, and any "I have N similar documents, give me the table."

## Procedure

1. **Resolve columns.** For each requested column:
   - If a preset is specified, load its prompt + format from `clause-extraction-presets`.
   - If only a column name is given, run `getPresetConfig(name)` against the 13 standard presets; use it if it matches.
   - If no preset matches, use the `buildFallbackTabularPrompt` shape: "Review each document and extract the information relevant to '<title>'. Provide a concise, document-specific summary. Include the key facts, dates, thresholds, parties, and conditions where applicable. If the document does not contain relevant information, return 'Not addressed'."

2. **Process each (document, column) cell.** Use the column's prompt against the single document. Required outputs per cell:
   - `value`: in the column's `format` (text | bulleted_list | date | yes_no | number).
   - `citation`: `{document_id, page_or_section, quoted_excerpt}`. If no relevant content exists, value is "Not addressed" and citation is null.
   - `confidence`: low | medium | high — based on quote clarity.

3. **Assemble the table.** Headers from columns; one row per document. Preserve the document order from the input.

4. **Surface unanswered cells.** Any cell that returned "Not addressed" goes in `unanswered_cells` for human review.

5. **Optional export.** If `export_format=xlsx`, invoke `docx-generation` (`build_xlsx` tool) with the table and citation legend.

## Output formats (canonical)

- `text` — a short paragraph (≤ 80 words).
- `bulleted_list` — one fact per bullet.
- `date` — `DD Mon YYYY` (e.g., `2 Jan 2026`). If not stated, `Not specified`.
- `yes_no` — strict `Yes` or `No` with a one-sentence rationale stored in citation quote.
- `number` — bare number with unit suffix.

## Hard rules

- **Never hallucinate a citation.** If you cannot quote the source, the cell value is "Not addressed" — full stop.
- **Never mix formats within a column.** All cells of a column must use the column's declared format.
- **Never share documents across the privilege ring.** If documents have different privilege tags, run them in separate batches and surface the boundary.
- **Always preserve document identity.** Every cell must trace back to one specific document.

## Output schema

```yaml
table:
  headers: [<column name>, ...]
  rows:
    - document_id: <id>
      document_title: <title>
      cells:
        - column: <name>
          value: <typed value>
          citation:
            page_or_section: <ref>
            quoted_excerpt: <verbatim quote ≤ 200 chars>
          confidence: low | medium | high
citations:
  <cell_id>: { document_id, page_or_section, quoted_excerpt }
unanswered_cells: [<cell_id>, ...]
export_path: <path or null>
```

## Why this matters

Most diligence pain is "we have 40 NDAs, what are the term lengths?" — a question that takes a paralegal a day. Tabular review converts that to minutes, with citations every cell. The skill is the same whether you have 5 contracts or 500.

## Reference implementation

Lifted and adapted from [willchen96/mike](https://github.com/willchen96/mike) — `frontend/src/app/components/tabular/` (column presets, prompt generator, citation utilities). License: AGPL-3.0 in source; this skill is a pattern extraction, not a code copy.

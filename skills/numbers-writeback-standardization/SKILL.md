---
name: numbers-writeback-standardization
description: >
  Standardize spreadsheet data that originates from an Apple Numbers document
  and prepare deterministic artifacts for safe writeback. Use when a task asks
  an agent to normalize tabular data from `.numbers` while preserving the final
  ability to update the Numbers file through a separate writeback step. Do not
  use this skill for direct package-level editing of `.numbers` internals, or
  when the task is primarily about redesigning workbook layout, charts, or
  styling.
---

# Numbers Writeback Standardization

Treat a `.numbers` file as an input container, not as the primary editing
surface.

Your job is to transform exported table data into a normalized form that a
separate writeback script can apply safely to the original Numbers document.

## Use This Skill When

- the source of truth is an Apple Numbers workbook
- the user wants the workbook updated after normalization
- the tabular content should be cleaned, reconciled, or standardized
- the workflow can export data from Numbers to `csv` or `json` first

## Do Not Use This Skill When

- the task requires direct mutation of `.numbers` package internals
- the main goal is visual redesign, charts, conditional formatting, or formulas
- no exported sheet/table data is available yet

## Required Inputs

Before doing domain work, gather or confirm:

1. path to the source `.numbers` file
2. exported table data as `csv` or `json`
3. target workbook structure:
   - sheet name
   - table name if known
   - expected primary key or row identity strategy
4. normalization rules:
   - canonical column names
   - date format
   - currency format
   - enum/category mappings
   - empty/null handling

If one of these is missing, make the smallest safe assumption and state it in
the output summary.

## Core Rules

1. Never directly edit the `.numbers` bundle contents.
2. Preserve row identity whenever possible. Prefer a stable business key over
   positional row numbers.
3. Keep original values traceable. Every destructive change must be explainable
   from the output artifacts.
4. Separate normalization from publication. First produce normalized artifacts,
   then produce a writeback plan.
5. If the exported data is ambiguous, stop short of guessing and mark the row or
   field for review.

## Workflow

### Step 1 - Inspect Inputs

- identify all sheets/tables represented in the export
- infer headers, field types, and likely key columns
- detect risky fields: formulas, merged headers, duplicated rows, empty header
  names, mixed date formats, mixed currencies

### Step 2 - Define the Canonical Shape

For each target table, decide:

- canonical column order
- canonical column names
- required vs optional columns
- normalized types (`string`, `number`, `integer`, `date`, `datetime`,
  `boolean`, `currency`, `enum`)
- validation rules

### Step 3 - Normalize

Apply only deterministic transformations such as:

- trim whitespace
- standardize casing when appropriate
- convert dates to one chosen format
- convert money fields to one chosen currency representation
- map aliases into canonical categories
- split or merge fields only when the rule is explicit
- flag rows that cannot be normalized confidently

### Step 4 - Produce Writeback Artifacts

Always produce these artifacts:

- `normalized/<table>.csv`
- `writeback/writeback-plan.json`
- `writeback/standardization-summary.md`

If multiple tables exist, create one normalized CSV per table and include each
table in the same plan file.

## Output Contract

Follow the artifact contract in
[`references/output-contract.md`](references/output-contract.md) exactly.

The writeback plan exists so another tool can update the Numbers workbook
without asking the model to reinterpret the cleaned data.

## Review Checklist

Before finishing, confirm:

- every output table has a declared `sheetName`
- every output table has a declared `matchStrategy`
- every normalized column maps back to an input or an explicit derivation rule
- unresolved rows are listed under `manualReview`
- the summary explains assumptions, transformations, and writeback risks

## Completion Standard

The task is complete only when the normalized data and writeback plan are clear
enough that a deterministic script could update the target Numbers workbook
without additional model reasoning.

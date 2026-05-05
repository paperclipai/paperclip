# Phase 90: Trello Automation / Power-up Parity (1) - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-05-05
**Phase:** 90-trello-automation-power-up-parity-1
**Mode:** auto (--auto --chain)
**Areas discussed:** Custom field schema, Custom field UI, Board calendar view, Custom field management

---

## Custom field schema

[auto] All decisions made in --auto mode with recommended defaults applied.

### Decisions Made
- **D-01:** Custom field definitions stored in a new `rt2WorkBoardCustomFields` table — board-level field configuration (name, type, options)
- **D-02:** Custom field values stored in a new `rt2WorkBoardCardCustomFieldValues` table — per-card field values (issueId, fieldId, value)
- **D-03:** Field types: `text`, `number`, `date`, `dropdown` — supported in that order

---

## Custom field types

### Decisions Made
- **D-04:** Text fields: free-form string value
- **D-05:** Number fields: numeric value with optional decimal
- **D-06:** Date fields: timestamp (reuse dueDate timestamp pattern)
- **D-07:** Dropdown fields: optionId reference to `rt2WorkBoardCustomFieldOptions` table

---

## Custom field UI on cards

### Decisions Made
- **D-08:** Card detail panel shows custom fields as key-value pairs
- **D-09:** Inline editing on card detail (click to edit)
- **D-10:** Card quick-view shows first 2-3 custom fields as chips on the card face

---

## Board calendar view

### Decisions Made
- **D-11:** Calendar view is a separate tab/mode on the board (not replacing kanban)
- **D-12:** Calendar shows cards filtered by dueDate — same dueDate data from Phase 89 (timestamp field)
- **D-13:** Month view with cards grouped by due date (day cells show card titles)
- **D-14:** Click on card in calendar navigates to card detail

---

## Custom field management

### Decisions Made
- **D-15:** Board settings panel for managing custom fields (add/edit/delete/reorder)
- **D-16:** Dropdown options managed per field (add/remove options)

---

## Auto-Resolved

[auto] All gray areas auto-resolved with recommended defaults per --auto mode.

---

## OpenCode's Discretion

- Exact calendar UI component (full-width modal vs tab panel)
- Calendar library choice (date-fns Calendar vs custom grid)
- Custom field chips display format and truncation
- Dropdown option picker UI (modal vs inline dropdown)

---

## Deferred Ideas

- Formula-based custom fields (POWER-04) — Phase 91 scope
- WIP limits per lane (POWER-05) — Phase 91 scope
- Card templates (POWER-06) — Phase 91 scope
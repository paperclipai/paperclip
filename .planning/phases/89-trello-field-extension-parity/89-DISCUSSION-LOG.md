# Phase 89: Trello Field Extension Parity - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-05-04
**Phase:** 89-trello-field-extension-parity
**Mode:** auto (--auto --chain)
**Areas discussed:** Checklist tracking, Due date with time, Colored labels, Card members

---

## Checklist tracking

[auto] All decisions made in --auto mode with recommended defaults applied.

### Decisions Made
- **D-01:** Progress percentage shown on card as "X/Y completed" with visual progress indicator
- **D-02:** Checklist items support title edit and checkbox toggle inline
- **D-03:** Reorder checklist items via drag handle

---

## Due date with time

### Decisions Made
- **D-04:** Date picker with optional time field (HH:mm)
- **D-05:** Overdue cards show red indicator; due today show yellow; future show default
- **D-06:** Due date editable from card detail panel and quick-edit popover

---

## Colored labels

### Decisions Made
- **D-07:** Existing `labels` + `issueLabels` tables used — no new schema needed
- **D-08:** Cards display label color chips (max 3 visible, +N overflow indicator)
- **D-09:** Label management (create/edit/delete) in board settings or card detail

---

## Card members

### Decisions Made
- **D-10:** Existing `rt2V33TaskParticipants` table used for member tracking
- **D-11:** Cards show member avatars (max 3, +N overflow)
- **D-12:** Member assignment via card detail panel with user picker

---

## Auto-Resolved

[auto] All gray areas auto-resolved with recommended defaults per --auto mode.

---

## OpenCode's Discretion

- Exact color palette for labels
- Label chip size and shape
- Member avatar size and overlap style
- Calendar view (deferred to Phase 90/POWER-03)

---

## Deferred Ideas

- Card templates (POWER-06) — Phase 91 scope
- Calendar view filtered by due date (POWER-03) — Phase 90 scope
- Formula-based fields (POWER-04) — Phase 91 scope
- WIP limits per lane (POWER-05) — Phase 91 scope

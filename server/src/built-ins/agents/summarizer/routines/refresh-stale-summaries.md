---
routineKey: refresh-stale-summaries
title: Refresh {{scopeKind}} summary slot {{slotKey}}
description: Bounded, paused-by-default refresh of one explicitly named summary slot. Spends no tokens until an operator runs it with scopeKind, scopeId, and slotKey. Read-and-report only — it never mutates issues, workspaces, or code.
assigneeRef:
  resourceKind: agent
  resourceKey: summarizer
status: paused
priority: medium
concurrencyPolicy: coalesce_if_active
catchUpPolicy: skip_missed
variables:
  - name: scopeKind
    label: Summary scope kind
    type: select
    defaultValue: null
    required: true
    options:
      - project
      - workspaces_overview
      - project_workspace
  - name: scopeId
    label: Scope id (omit only for workspaces_overview)
    type: string
    defaultValue: null
    required: false
    options: []
  - name: slotKey
    label: Summary slot key
    type: string
    defaultValue: status
    required: true
    options: []
triggers: []
issueTemplate:
  surfaceVisibility: normal
---

# Refresh one summary slot

This routine is **paused by default** and spends no tokens until an operator triggers a manual run with a concrete summary-slot target.

## What this run must do

1. Work only on `scopeKind={{scopeKind}}`, `scopeId={{scopeId}}`, `slotKey={{slotKey}}`. These values are materialized into the issue and wake context; do not infer or broaden them.
2. Run the `summarize-status` skill as the operating procedure: read the current revision, read the company-scoped state needed for that one scope, and write one new Markdown revision back to the slot.
3. If the scope has no meaningful change since its last revision, close the issue with an unchanged result instead of rewriting the summary.

## Hard limits for this routine

- Read-and-report only. This routine must never change issues, workspaces, code, or agent configuration — its only write is the summary revision.
- Keep every read company-scoped. Do not cross company boundaries.
- Run on the low-cost model profile lane (`cheap`). Keep each summary short.
- Never fabricate status and never surface secrets from issue bodies or configs.

## Output

A single bounded routine issue for the named slot, plus a summary comment listing the scope, revision written or unchanged result, and any read failure with its unblock owner.

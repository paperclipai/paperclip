---
routineKey: refresh-stale-summaries
title: Refresh stale summary slots
description: Bounded, paused-by-default sweep that regenerates summary slots whose underlying scope has changed since the last revision. Spends no tokens until an operator enables its schedule or runs it manually. Read-and-report only — it never mutates issues, workspaces, or code.
assigneeRef:
  resourceKind: agent
  resourceKey: summarizer
status: paused
priority: medium
concurrencyPolicy: coalesce_if_active
catchUpPolicy: skip_missed
variables:
  - name: staleAfterHours
    label: Refresh slots older than (hours)
    type: number
    defaultValue: 24
    required: false
    options: []
  - name: maxSlots
    label: Max slots to refresh per run
    type: number
    defaultValue: 10
    required: false
    options: []
  - name: scopeKinds
    label: Scope kinds to include
    type: select
    defaultValue: all
    required: false
    options:
      - all
      - project
      - workspaces_overview
      - project_workspace
triggers:
  - kind: schedule
    label: Daily stale-summary refresh
    enabled: false
    cronExpression: "0 8 * * *"
    timezone: UTC
    signingMode: none
    replayWindowSec: 0
issueTemplate:
  surfaceVisibility: normal
---

# Refresh stale summary slots

This routine is **paused by default** and spends no tokens until an operator enables its schedule or triggers a manual run. The first release of the Summarizer is manual-generation-first; this routine exists so operators can opt into scheduled refreshes without background spend by default.

## What this run must do

1. Select summary slots whose scope has changed since their last revision and whose `lastGeneratedAt` is older than `{{staleAfterHours}}` hours. Restrict to `{{scopeKinds}}` when a specific kind is chosen. Cap the set at `{{maxSlots}}`, most-stale first.
2. For each selected slot, run the `summarize-status` skill as the operating procedure: read the current revision, read the company-scoped state you need to understand where things are, and write one new Markdown revision back to the slot.
3. Skip slots with no meaningful change since their last revision — do not spend tokens rewriting an unchanged summary.

## Hard limits for this routine

- Read-and-report only. This routine must never change issues, workspaces, code, or agent configuration — its only write is the summary revision.
- Keep every read company-scoped. Do not cross company boundaries.
- Run on the low-cost model profile lane (`cheap`). Keep each summary short.
- Never fabricate status and never surface secrets from issue bodies or configs.

## Output

A single bounded routine issue that links the slots refreshed this run, plus a summary comment listing: scopes summarized, revisions written, slots skipped as unchanged, and any slot that could not be read (with the unblock owner).

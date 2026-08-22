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
      - execution_workspace
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

1. Claim the bounded refresh set with `POST /api/companies/{companyId}/summary-slots/routine-refresh/claim`, sending this routine execution issue id as `generationIssueId` plus `staleAfterHours: {{staleAfterHours}}`, `maxSlots: {{maxSlots}}`, and `scopeKinds: "{{scopeKinds}}"`. The endpoint returns only stale slots whose scope changed, most-stale first, and binds this checked-out routine task as their active generator.
2. For each claimed slot, run the `summarize-status` skill as the operating procedure: use the returned document and `latestRevisionId`, read the company-scoped state you need to understand where things are, and write one new Markdown revision back to that exact slot with this routine issue as `generationIssueId`.
3. Skip slots with no meaningful change since their last revision — do not spend tokens rewriting an unchanged summary.

## Hard limits for this routine

- Read-and-report only. This routine must never change issues, workspaces, code, or agent configuration — its only write is the summary revision.
- Keep every read company-scoped. Do not cross company boundaries.
- Run on the enabled low-cost model profile lane (`cheap`). The stock Summarizer maps this lane to Claude Haiku 4.5; an operator may replace it with another approved low-cost model. Keep each summary short.
- Never fabricate status and never surface secrets from issue bodies or configs.

## Output

A single bounded routine issue that links the slots refreshed this run, plus a summary comment listing: scopes summarized, revisions written, slots skipped as unchanged, and any slot that could not be read (with the unblock owner).

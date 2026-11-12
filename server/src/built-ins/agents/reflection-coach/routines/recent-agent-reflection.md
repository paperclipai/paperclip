---
routineKey: recent-agent-reflection
title: Review recent agent trajectories for coaching proposals
description: Bounded reflection sweep over recently active agents that produces evidence-backed coaching proposals only. Never mutates another agent's live instructions, skills, or tool descriptions without an accepted task interaction.
assigneeRef:
  resourceKind: agent
  resourceKey: reflection-coach
status: paused
priority: medium
concurrencyPolicy: coalesce_if_active
catchUpPolicy: skip_missed
variables:
  - name: lookbackDays
    label: Lookback window (days)
    type: number
    defaultValue: 7
    required: false
    options: []
  - name: maxTargetAgents
    label: Max target agents per run
    type: number
    defaultValue: 8
    required: false
    options: []
  - name: targetAgentMode
    label: Target selection mode
    type: select
    defaultValue: recent_active
    required: false
    options:
      - recent_active
      - all
      - explicit
  - name: excludeAgentIds
    label: Agent ids to exclude (comma-separated)
    type: string
    defaultValue: null
    required: false
    options: []
triggers:
  - kind: schedule
    label: Weekly reflection sweep
    enabled: false
    cronExpression: "0 9 * * 1"
    timezone: UTC
    signingMode: none
    replayWindowSec: 0
issueTemplate:
  surfaceVisibility: normal
---

# Recent agent reflection sweep

This routine is **paused by default** and spends no tokens until an operator enables its schedule or triggers a manual run. When it runs, it produces coaching proposals only.

## What this run must do

1. Select target agents using `{{targetAgentMode}}`:
   - `recent_active` — agents with completed/in-review/blocked issue activity within the last `{{lookbackDays}}` days.
   - `all` — every non-terminated agent in the company.
   - `explicit` — only agents named in the run inputs.
   Cap the set at `{{maxTargetAgents}}`. Drop any agent id listed in `{{excludeAgentIds}}`, and always drop your own `PAPERCLIP_AGENT_ID` (no self-reflection).
2. For each selected target, run the `reflection-coach` skill as the operating procedure: pull recent trajectories, read current AGENTS.md and assigned skills, cluster evidence-backed patterns, and draft the smallest durable change.
3. Produce, per target agent, a proposal document with clustered patterns, linked issue/comment evidence, minimal diffs, and replay cases. Create a follow-up proposal issue when a change is worth carrying forward.

## Hard limits for this routine

- Proposal-only. This routine must not edit any agent's live AGENTS.md, skill assignments, or tool descriptions directly.
- Any actual instruction/skill/tool-description change requires a displayed diff and an **accepted** `request_confirmation` task interaction, applied only in a separate follow-up run.
- Mutation confirmations must bind the exact resource key they will apply, using `agent:<agentId>:instructions`, `agent:<agentId>:profile`, `skill:<skillId>`, `skill-slug:<slug>`, `skill-import:<source>`, or `skills:scan-projects`.
- Keep every read company-scoped. Do not cross company boundaries.
- Every proposed rule needs linked issue/comment evidence or it is dropped. No scoring without trajectories.
- Respect the size caps: AGENTS.md +20% max per proposal, skills 15KB max, tool descriptions 500 chars max.

## Output

A single bounded routine issue that links one proposal document (or follow-up proposal issue) per reviewed target agent, plus a summary comment listing: agents reviewed, window, clusters found, surfaces proposed, and the next-step owner for each accepted-or-pending change.

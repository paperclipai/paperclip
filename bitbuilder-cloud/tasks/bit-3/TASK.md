---
name: "Review recent agent trajectories for coaching proposals"
assignee: "ceo"
---

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
    enabled

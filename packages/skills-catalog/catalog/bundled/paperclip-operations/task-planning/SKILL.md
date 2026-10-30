---
name: task-planning
description: Write or revise a useful Paperclip plan with a clear outcome and verification. Use when a plan is requested or uncertainty needs resolving before execution.
key: paperclipai/bundled/paperclip-operations/task-planning
recommendedForRoles:
  - manager
  - engineer
  - product
tags:
  - paperclip
  - planning
  - issues
  - delegation
---

# Task planning

Plan only as much as the work needs. If execution is authorized and the next step
is small and clear, do it. A request for a plan alone does not require child tasks
or a new approval gate.

Describe the intended outcome, relevant constraints, chosen approach, and how to
verify success. Include uncertainties or decisions that affect execution. Use the
user's preferred format; keep implementation steps within one owner's task unless
another owner, useful parallel output, dependency, or independent review warrants
separate work.

Save a requested plan as the issue document with key `plan`. Update its current
revision instead of duplicating it, and link the saved document in your response.
Use the native document tools when available; legacy agents follow the `paperclip`
skill's document and planning API mechanics.

Respect planning mode and explicit approval requests. When approval is required,
request confirmation of the latest plan revision and wait for that decision.
After acceptance, execute cohesive work on the current ordinary task. Use
`paperclip-converting-plans-to-tasks` when delegation is justified.

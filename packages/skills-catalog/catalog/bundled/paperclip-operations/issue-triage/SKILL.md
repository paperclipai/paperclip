---
name: issue-triage
description: Triage assigned Paperclip work or an explicitly authorized coordination scope; identify real waits, execution gaps and the next action while preserving owners and release gates.
key: paperclipai/bundled/paperclip-operations/issue-triage
recommendedForRoles:
  - manager
  - ceo
  - engineer
tags:
  - paperclip
  - triage
  - inbox
  - workflow
---

# Issue Triage

Leave each inspected issue with an evidence-based classification, owner and next action. Read [Continuity during triage](references/continuity.md) before acting; it defines release gates, routing, readiness and return evidence.

## When to use

Use for an assigned triage request or an authorized coordination pass over an explicit set of issues. A named issue wake takes precedence: work that issue, without expanding to the inbox. An open question requires checking what it actually prevents; continue independent authorized work.

## Inputs

Use the scoped wake first. For an authorized inbox pass, prefer `GET /api/agents/me/inbox-lite`; use each candidate's `GET /api/issues/{issueId}/heartbeat-context`. Read more history or native blocker/wake diagnostics only as needed, respecting coverage.

## Per-issue triage decision

Choose the smallest justified action:

| Classification | Action |
| --- | --- |
| Healthy execution or valid persisted continuation | Let it proceed; avoid redundant comments or duplicate work. |
| Backlog awaiting release/capacity | Preserve backlog, owner and coordination route. Do not create execution. |
| Pertinent wait | Verify current object/recipient/state/continuation. Apply an existing answer; preserve a genuine wait. Historical questions alone are not blockers. |
| Execution gap | Establish current authorization/capacity and absence of a live continuation. Reuse the assigned task and supported continuation mechanism; verify the receipt. Comment/status alone does not prove wake or admission. |
| Actual dependency | Check native readiness/finalization and all relevant paths. Cancelled or pending-finalize dependencies do not release work. Preserve independent fronts. |
| Technical/admission/workspace failure | Record concrete failure and reuse the designated technical route. Assign exact execution where needed; preserve the source owner. A specialty mismatch or age alone does not justify reassignment. |
| Business decision or formal approval needed | Use the competent existing flow and recipient; preserve current gates. Technical diagnosis stays internal. |
| Acceptance met | Confirm the issue's own evidence and remaining obligations before closure. Do not cancel cross-team work or close a parent just because children ended. |

A short read that leaves uncertainty calls for bounded investigation and explicit limits, not automatic escalation. Rank findings by urgency and impact without changing commercial priority.

## Output

Record UTC, source/revision, issue/project/owner, observed evidence, classification, one action, saved return route and next responsible person. Verify any saved assignment or interaction set. Do not repeat a blocked update without new context. Publication, consumer loading, real use and incident recovery have separate proof requirements.

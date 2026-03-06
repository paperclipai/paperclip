---
id: paperclip-feature-wake-delete-issue
title: Wake Agent from Issues List + Delete Issue
doc_type: spec
owner: paperclip
status: active
version: 1.0.0
updated: 2026-03-06
applies_to:
  - ui
depends_on: []
related_docs:
  - /home/avi/projects/paperclip/docs/specs/agent-models-settings.md
toc: auto
---

Two board-facing UX additions to the issues workflow.

## Wake Agent from Issues List

### Location

Issues list (`/issues`) — each row where `status = in_progress` and an agent is assigned.

### Behavior

| Detail | Value |
|--------|-------|
| Trigger | ⚡ button in the issue row (right side, hidden on mobile) |
| Visibility | Only shown when `status = in_progress`, `assigneeAgentId` is set, and no live run is already active |
| API call | `POST /api/agents/:assigneeAgentId/wakeup` with `source: "on_demand"`, `triggerDetail: "manual"`, issue ID as payload |
| Loading state | Per-row spinner while the request is in-flight |
| On success | Toast: "Agent woke up" or "Agent did not wake" depending on response |
| On error | Toast: "Wake failed" with error message |

### Implementation

| File | Role |
|------|------|
| `ui/src/components/IssuesList.tsx` | Wake button, `handleWakeIssue`, `wakingIssueIds` state |

---

## Delete Issue

### Location

Issue detail page (`/issues/:id`) → `⋯` (MoreHorizontal) menu.

### Behavior

| Detail | Value |
|--------|-------|
| Access | Board members only (via the `⋯` menu) |
| Confirm pattern | First click shows "Confirm?"; second click sends delete. Dismissing the popover resets the confirm state. |
| API call | `DELETE /api/issues/:id` |
| After delete | Navigates to `/issues` and invalidates the issue list cache |

### Implementation

| File | Role |
|------|------|
| `ui/src/pages/IssueDetail.tsx` | `deleteIssue` mutation, `confirmDelete` state, menu item |

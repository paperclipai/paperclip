---
id: paperclip-feature-issue-detail-wake-assignee
title: Issue Detail Wake Assignee
doc_type: spec
owner: paperclip
status: active
version: 1.0.0
updated: 2026-03-05
applies_to:
  - ui/src/pages/IssueDetail.tsx
depends_on:
  - /home/avi/projects/paperclip/docs/api/issues.md
related_docs:
  - /home/avi/projects/paperclip/AGENTS.md
toc: auto
---

# Issue Detail Wake Assignee

Issue detail should expose a direct manual wake action for the currently assigned agent.

## Behavior

- Show a wake action only when `assigneeAgentId` is present
- Call `POST /api/agents/{agentId}/wakeup`
- Include `issueId`, `taskId`, and `taskKey` in the wake payload
- Surface successful wakeups with a run link
- Surface skipped wakes when the agent is paused or wake-on-demand is disabled

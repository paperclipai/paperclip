---
id: paperclip-delegate-issue-transfer-approval
title: Delegate Issue Transfer Approval
doc_type: spec
owner: paperclip
status: active
version: 1.0.0
updated: 2026-03-05
applies_to:
  - server/src/routes/approvals.ts
  - ui/src/components/ApprovalPayload.tsx
  - packages/shared/src/constants.ts
depends_on:
  - /home/avi/projects/paperclip/docs/api/approvals.md
  - /home/avi/projects/paperclip/docs/api/issues.md
related_docs:
  - /home/avi/projects/paperclip/AGENTS.md
toc: auto
---

# Delegate Issue Transfer Approval

## Scope

Adds `delegate_issue_transfer` as an approval type for controlled cross-company delegation.

## Behavior

- Approval payload must include `sourceIssueId`, `sourceCompanyId`, and `targetCompanyId`.
- On approve, the server validates source issue ownership and creates a target issue in the destination company.
- Source issue is resolved, source and target are cross-linked, and an audit event is emitted.
- If a target assignee exists, a wakeup is queued for that agent.

## API/UI

- API now accepts `delegate_issue_transfer` in approval creation and approval execution flow.
- UI renders this payload in approval details for operator review.

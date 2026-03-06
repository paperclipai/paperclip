---
id: paperclip-feature-tasks-assign-scoped-delegation
title: Tasks Assign Scoped Delegation
doc_type: spec
owner: paperclip
status: active
version: 1.0.0
updated: 2026-03-05
applies_to:
  - server
depends_on:
  - /home/avi/projects/paperclip/doc/plans/tasks-assign-scoped-delegation-model.md
related_docs:
  - /home/avi/projects/paperclip/docs/api/issues.md
toc: auto
---

# Tasks Assign Scoped Delegation

## Purpose

Enable non-board principals to perform `tasks:assign` within explicit guardrails, without granting global assignment power.

## Scope Grant Contract

Permission key: `tasks:assign_scope`

Scope payload:

```json
{
  "projectIds": ["<project-uuid>", "*"],
  "allowedAssigneeAgentIds": ["<agent-uuid>"],
  "allowedAssigneeRoles": ["pm", "security", "engineer"],
  "deniedAssigneeRoles": ["ceo"],
  "allowUnassign": false,
  "allowAssignToUsers": false
}
```

Validation rules:
- `projectIds` is required and non-empty.
- Each project id must be UUID or `*`.
- At least one of `allowedAssigneeAgentIds` or `allowedAssigneeRoles` is required.
- Unknown keys are rejected.
- `deniedAssigneeRoles` defaults to `["ceo"]`.

## Enforcement

Assignment mutations (`POST /api/companies/:companyId/issues`, `PATCH /api/issues/:id` when assignee changes):

1. Board local-implicit and instance-admin: unrestricted.
2. Other actors: require `tasks:assign`.
3. If `tasks:assign_scope` exists: assignment intent must pass scope evaluation.
4. If `PAPERCLIP_ASSIGN_SCOPE_STRICT=true` and scope grant is missing: deny.

Denied scope checks return:
- `403`
- `error: "Missing permission: tasks:assign_scope"`
- `details.reason` with machine-readable deny reason.

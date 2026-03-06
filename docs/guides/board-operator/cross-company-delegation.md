---
title: Cross-Company Delegation
summary: Move tasks between companies with approval-gated and manual bridge flows
---

Use this guide when you need to move work between separate company queues (for example, `CompanyA` -> `CompanyB`) while keeping auditability and ownership clear.

## Delegation Modes

### 1) Approval-Gated Transfer (Recommended)

Create a `delegate_issue_transfer` approval request from the source company, then execute transfer only after board approval.

Script:

```bash
scripts/request-delegation-approval.sh --issue-id <SOURCE_ISSUE_UUID> --commit
```

What it does:

- Creates a pending approval (`type=delegate_issue_transfer`)
- Stores source and target company metadata in approval payload
- Optionally maps `TeamB-*` assignee names to `TeamA-*` in target company (or explicit assignee)

Then approve via UI or API:

```bash
POST /api/approvals/{approvalId}/approve
```

### 2) Manual Bridge Copy

Use this only when you explicitly want an immediate copy without an approval gate.

Script:

```bash
scripts/bridge-issue-cross-company.sh --issue-id <SOURCE_ISSUE_UUID> --commit
```

Useful flags:

- `--dry-run` preview payload only
- `--keep-status` keep source issue status in target
- `--no-assignee` create unassigned in target
- `--force` bypass assignment template guards for controlled bridge cases
- `--no-source-comment` skip writing bridge comment back to source issue

## Ownership Mapping

Default role mapping pattern for manual bridge:

- `TeamA-<Role>` -> `TeamB-<Role>`

For approval-gated flow:

- If source assignee is `TeamB-<Role>` and target is TeamA company, it attempts `TeamA-<Role>`
- You can override with explicit `--target-assignee-agent-id`

## Operational Notes

- If target status requires assignee (`todo`, `in_progress`), provide a valid assignee.
- Keep source and target companies separate for clean access boundaries.
- Prefer approval-gated transfer for governance-sensitive handoffs.

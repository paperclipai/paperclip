# RBD Family Office

RBD Family Office is a private personal operations company for family logistics, finance administration, records, home/admin work, and personal planning.

It is designed for draft-first support: agents can organize information, prepare checklists, summarize options, and draft approval packets, but sensitive work stays internal until the human board approves it.

## Workflow

The company runs as a hub-and-spoke family office.

The RBD Chief of Staff owns intake, prioritization, weekly review, and delegation. Specialist stewards handle family operations, finance administration, records/research, and privacy/approval review. Work returns to the Chief of Staff as concise next actions or approval packets.

## Org Chart

| Agent | Title | Reports To | Skills |
| --- | --- | --- | --- |
| `rbd-chief-of-staff` | Chief of Staff | Board | `personal-ops`, `approval-gate` |
| `family-ops-steward` | Family Operations Steward | `rbd-chief-of-staff` | `family-ops`, `personal-ops`, `approval-gate` |
| `finance-steward` | Finance Steward | `rbd-chief-of-staff` | `finance-admin`, `records-research`, `approval-gate` |
| `records-research-lead` | Records and Research Lead | `rbd-chief-of-staff` | `records-research`, `personal-ops`, `approval-gate` |
| `qa-approval-editor` | QA and Approval Editor | `rbd-chief-of-staff` | `approval-gate`, `records-research` |

## Starter Projects

- `personal-planning-inbox`: triage, prioritization, and weekly family-office planning.
- `family-operations`: family calendar, logistics, errands, travel, and recurring commitments.
- `finance-admin`: budgets, bills, subscriptions, tax-prep checklists, and financial review packets.
- `records-and-documents`: document inventories, renewals, warranties, policies, and admin records.
- `home-and-admin`: household maintenance, vendors, purchases, and admin follow-through.

## Getting Started

Import the package into Paperclip:

```sh
paperclipai company import doc/company-packages/rbd-family-office --target new
```

This package follows the [Agent Companies specification](https://agentcompanies.io/specification) and is intended for use with [Paperclip](https://github.com/paperclipai/paperclip).

---
name: approval-gate
description: >
  Require human approval before external-facing, sensitive, irreversible, or
  approval-bound work is treated as final. Use for drafts, approval packets,
  client/prospect/user-facing output, financial/account changes, publishing,
  purchases, scheduling commitments, or actions that should wait for a human
  board decision.
metadata:
  paperclip:
    requiredByDefault: false
---

# Approval Gate

Use this skill whenever work may leave the internal company context, change an
external system, create a commitment, or touch sensitive information.

Before handoff:

- Label the artifact or action as a draft or pending approval.
- State the audience, destination, and intended use.
- List assumptions, risks, and missing context.
- Identify sensitive details that should be confirmed or removed.
- Ask for a specific human approval decision.
- Do not claim the item was sent, published, purchased, booked, changed, or
  accepted unless the human board explicitly confirms it.

If approval is granted, proceed only within the approved scope. If approval is
denied or unclear, keep the work in draft state and report what needs to change.

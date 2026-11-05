---
name: paperclip-converting-plans-to-tasks
description: >
  Decide whether Paperclip work needs delegation, and connect justified tasks
  with owners and real dependencies. Use when turning an authorized plan into work.
---

# Plans to tasks

Keep small, cohesive work on its current ordinary task with one end-to-end owner.
A plan's steps, files, and phases do not each need a task.

Create a separate task only for a useful boundary: another owner or permission,
independent parallel output, a real prerequisite, independent review, or substantial
follow-up that needs its own lifecycle. Check the available agents before assigning.
Give each delegate enough context and a clear deliverable to work independently.

Set real dependencies through `blockedByIssueIds` (or the native dependency tool).
Parent/child nesting and prose do not delay execution. Independent work can start
now; dependent work must wait for its prerequisite. Verify the saved relationships.

Reviewers publish findings on their own review task and complete it, including an
adverse verdict. Make its description self-contained. Connect the verdict to the
owner who must act on it; do not require writes to the parent.

Honor existing authorization and approval boundaries. Use Paperclip's planning
mechanics when approval is required; decomposition does not create new approval gates.

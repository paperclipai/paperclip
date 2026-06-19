# AI Factory SOP

Paperclip execution uses a two-level issue topology.

```text
Main parent issue
  - execution lane 1
  - execution lane 2
  - execution lane N
```

There are no execution grandchildren.

## Topology Rules

- A main parent issue may create direct child execution lanes.
- A parent issue may have at most 10 direct child execution lanes.
- An execution lane is any issue with `parentId` set.
- Execution lanes must not create child issues.
- Engineer, QA, fix, and review loops stay inside the same execution-lane issue thread.
- Hard blockers are reported in the execution lane and escalated to the PM, execution manager, CEO, or board through comments, status, blockers, review, approval, or issue-thread interactions.
- Parent issues can set `budgetLimits.issueTreeCents` to cap the parent plus direct lanes, and `budgetLimits.childIssuesCents` to cap execution lanes only.

## Role Rules

- Board, CEO, CTO, PM, and execution-manager agents operate mainly on parent issues.
- Parent-facing agents may create bounded direct child execution lanes for parallelism.
- Specialist agents operate inside one execution lane and should not create additional issues for normal delegation, QA, fixes, or follow-up.
- If a specialist believes more work is needed, it should comment with the proposed lane/follow-up and block or escalate the current issue instead of creating a new issue directly.

## Correct Patterns

- Parent issue plans up to 10 parallel deliverables and creates direct child execution lanes.
- Engineer completes implementation in an execution lane, then QA comments or review stages drive fixes inside that same lane.
- A blocker appears in an execution lane; the lane is marked blocked with a named unblock owner/action.
- PM reviews blocked lanes from the parent issue and decides whether to revise scope, create another sibling lane, or escalate to board.

## Incorrect Patterns

- An execution lane creates another child issue.
- QA creates a separate sub-issue under an execution lane for fixes.
- An engineer creates several follow-up child issues instead of using comments/review/status inside the current lane.
- Agents recursively decompose work beyond parent plus direct children.

## Enforcement

The issue service rejects:

- creating a child under an issue that already has `parentId`;
- creating more than 10 direct children under one parent.

UI surfaces should hide sub-issue creation for execution lanes, but backend enforcement is authoritative.
Issue budget hard-stops also apply to issue trees: `issue_tree` cancels parent plus lanes, and `issue_children` cancels lanes without cancelling the parent board-facing thread.

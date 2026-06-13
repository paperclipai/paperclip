---
name: "paperclip-implement-plan"
description: ">"
slug: "paperclip-implement-plan"
metadata:
  paperclip:
    slug: "paperclip-implement-plan"
---

# Paperclip Implement Plan

This is the Paperclip-native port of `tac-4/.claude/commands/implement.md`. The original took a plan file path as `$ARGUMENTS`. In Paperclip the plan is `#document-plan` on the issue you're checked out on, so the implementation skill takes **no arguments**: the issue id is implied by the checkout.

## When to use

- The issue's `#document-plan` exists and the most recent `request_confirmation` interaction on that revision is `accepted`.
- The issue is `in_progress` and assigned to you (or you've just been woken by `issue_blockers_resolved` and the dependent plan is accepted).
- The plan's "Step-by-Step Tasks" section is concrete enough to execute without a second round of clarification.

## When NOT to use

- No plan, no approval, or approval is on a superseded revision → run  (or its revision flow) instead.
- The plan was approved but the workspace state has materially drifted from what the plan describes → write a new plan revision and re-confirm.
- The plan factors into delegated child issues — implement each child issue separately; the parent issue waits via `blockedByIssueIds`.
- The issue is a `spike` whose deliverable is a doc or recommendation, not code — write the artifact directly, do not run a code-implementation loop.

## Inputs (Paperclip primitives, not files)

1. `GET /api/issues/{issueId}/documents/plan` — the authoritative work item.
2. `GET /api/issues/{issueId}/heartbeat-context` — current status, ancestors, recent comments, current execution workspace.
3. `GET /api/execution-workspaces/{id}` — verify the checkout is healthy, branch is correct, and no other agent is mid-commit.
4. The label on the issue (`bug`/`feature`/`chore`/`spike`) — drives commit type and validation strictness.
5. (As needed) `GET /api/issues/{issueId}/comments?after=…` — pull in any board / reviewer feedback since the plan was accepted.

## The execution loop

For each task in the plan's "Step-by-Step Tasks", in order:

1. **Read the task heading + bullets.** If a bullet is genuinely ambiguous, do not guess — post a question via `ask_user_questions` interaction and exit the heartbeat.
2. **Make the smallest set of code/doc changes that satisfies the bullets.** Stay strictly inside the "Relevant Files" set unless the task explicitly says otherwise. Do not refactor neighbouring code "while you're there."
3. **Run the relevant subset of "Validation Commands"** if the plan calls them out for that step. Otherwise hold validation until all steps are done.
4. **Commit using .** One logical change per commit; do not pile multiple steps into one commit.
5. **If a step turns out to require new sub-work** that doesn't fit one commit, create a child issue with `parentId` and the issue's `goalId`, mark a `blockedByIssueIds` link if the parent must wait for it, and continue with the next non-blocked step.

At the end of the loop, run **all** validation commands listed in the plan. Every command must exit zero. If any command fails:

- Diagnose the root cause; do not edit the test to make it pass.
- If the fix is small, address it and re-run.
- If the fix is structural, capture it as a new step in a plan revision and re-request confirmation.
- Never use `--no-verify`, `--force`, `--skip`, or equivalent flags to bypass a failing check.

## Workspace discipline

- Stay on the branch produced by . Do not push to `main`/`master`. Do not force-push the branch.
- Only `git push` when the local commit history is correct and the relevant commits include the Paperclip co-author trailer.
- Never modify another agent's branch. If you need their work, wait on it as a first-class blocker.
- Treat secrets, credentials, `.env`, and key files as read-only — never commit, never echo to comments.
- If the plan references files that do not exist, treat it as a plan-drift signal: stop, write a plan revision, re-confirm.

## Hand-off when implementation is done

When all steps are complete and validation is clean:

1. Push the branch.
2. Run  to open the PR. The PR description links the issue identifier and the plan document.
3. `PATCH /api/issues/{issueId}` with status `in_review` and a `comment` following . The Next section names the reviewer (Coder → QA / manager; QA → reporter).
4. If a separate QA / reviewer agent exists, reassign via `assigneeAgentId`. Do not leave the issue assigned to yourself with "please review" — that is not a reviewer path.

If the work is genuinely complete and no reviewer is required (e.g. a docs-only chore in a solo company), `PATCH` directly to `done` with the progress comment and the PR / commit links.

## Anti-patterns

- **Implementing without checking the plan revision.** A stale plan + new context can mean you ship the wrong thing. Always re-read the plan before each new step.
- **Marking the issue `done` after pushing the branch but before opening the PR.** The PR is part of the deliverable for any code change.
- **Silent scope creep.** Touching files outside "Relevant Files" because they "needed cleaning." If the cleanup is real, write a chore issue and link it; don't smuggle it in.
- **Skipping validation.** Validation Commands are the plan's contract with the reviewer. Skipping them on the grounds that "they probably pass" forfeits that contract.
- **Multiple unrelated changes in one commit.** One step → one commit (or a small ordered series). Reviewable diffs are a deliverable, not a nicety.
- **Looping on a failing test.** If validation fails twice in a row for the same reason, stop. Diagnose. If you don't have a root cause after the second attempt, post a `blocked` update naming the failure and the unblock action — do not keep editing.

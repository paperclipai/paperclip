---
name: implement-spec
description: >
  Implement specs and tickets into code using subagents and worktrees,
  driving an integration branch to merge and review.
---

# Implement-Spec Skill

Implement the result of spec and ticket workflows into code. The spec carries an associated ticket graph with blocking relationships; tickets form a frontier of ready work rather than a linear step list. This skill drives end-to-end implementation using delegation, worktrees, and integration branches, then merges and reviews the finished branch.

## When to Use

- A spec and its tickets are available and ready to implement
- You need to implement a whole feature across multiple files or modules
- Tickets have dependencies defining which work can start now

**When NOT to use:** Single-line fixes, typo corrections, or work with no spec or ticket tracker.

## Prerequisites

- An issue tracker with the spec and tickets loaded
- The ability to spawn subagents with a fresh context window
- Git worktree support for per-ticket branches

## How to Run

Invoke the implement-spec skill while working on the branch. The agent reads the spec and tickets, builds the task graph, and starts work.

## Quick Reference

- Spawn each implementer subagent with a fresh context window
- Context pointers — link to spec, tickets, research notes, and commits instead of duplicating content
- Worktrees — one per ticket, each on its own branch from the integration branch

## Procedure

1. Read the spec and tickets to understand the task graph.
2. Optionally spawn an exploration subagent for any exploration the tickets require; save notes outside the repo so all future subagents can read them.
3. Create the integration branch. If the issue tracker closes work through PRs, open a draft PR after the first merge, marked as closing the spec and tickets.
4. Spawn a fresh implementer subagent for each ticket, each in its own worktree on its own branch. Each implementer confirms its worktree is based on the integration branch (resetting onto it if not), builds the ticket, and merges the integration branch tip into its own branch before reporting done.
5. When an implementer completes, merge its work to the integration branch with a merger subagent.
6. When the frontier changes, spawn more implementer subagents for newly-ready tickets.
7. When all tickets are complete, run code review on the integration branch and fix all issues in one fresh implementer subagent.
8. Mark the draft PR ready for review, or resolve each ticket the way the issue tracker closes work, then report the integration branch.
9. Clean up all implementer subagent worktrees.

## Pitfalls

- Treating tickets as a linear step list instead of a dependency graph
- Duplicating spec or ticket content into subagent context instead of using pointers
- Running implementer subagents sequentially instead of in the background

## Verification

- Every ticket on the frontier has an owner subagent or is blocked by an incomplete dependency
- The integration branch contains all resolved tickets
- Code review on the integration branch passes with no open findings
- All implementer worktrees are removed after completion

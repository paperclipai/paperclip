---
name: issue-triage
description: Triage Paperclip inbox issues that are stale, blocked, in-review, or assigned-but-not-progressing, and decide a single next action per issue (resume, reassign, unblock, escalate, or close).
key: paperclipai/bundled/paperclip-operations/issue-triage
recommendedForRoles:
  - manager
  - ceo
  - engineer
tags:
  - paperclip
  - triage
  - inbox
  - workflow
---

# Issue Triage

Convert a noisy inbox into a small set of clear next actions. Each pass through this skill should leave every touched issue with a defined owner, status, and the single concrete action that will move it forward.

## When to use

- Daily or shift-start review of `in_progress`, `in_review`, and `blocked` assignments.
- An inbox has many open assignments and no clear priority.
- A manager wants a status read on their reports without asking each agent.
- You are woken by a comment that suggests an old issue stalled.

## When not to use

- You are checked out on one specific issue and the wake context names it. Work that issue, do not triage the whole inbox.
- An issue thread already has an open `request_confirmation` or `ask_user_questions`. Wait for the response — re-triage is noise.

## Inputs

- `GET /api/agents/me/inbox-lite` for the compact assignment list.
- For each candidate issue, `GET /api/issues/{issueId}/heartbeat-context` for compact state including `blockerAttention`, `executionState`, ancestors, and `commentCursor`.
- Only fall back to the full thread when the heartbeat context is not enough.

## Per-issue triage decision

For each issue, classify into exactly one of:

1. **Resume** — execution path is alive. Confirm the assignee is set and let the heartbeat continue. Do not comment.
2. **Wake-needed** — assignee is stalled with no live continuation. Post one comment that names the blocker resolution or the exact next action, then leave `in_progress` or move to `todo` so the assignee picks it up.
3. **Reassign** — the assignee is not the right specialty. Reassign and set `in_review` only if the new assignee is human, otherwise leave `in_progress`.
4. **Unblock** — a first-class `blockedByIssueIds` entry is now `done` or `cancelled`. If `cancelled`, replace or remove it from `blockedByIssueIds`. The blockers-resolved wake will fire automatically when all are `done`.
5. **Escalate** — the issue needs board, CTO, or user input. Create a `request_confirmation`, `ask_user_questions`, or `request_board_approval` and set the issue to `in_review`.
6. **Close** — work is complete, duplicate, or no longer relevant. Set `done` or `cancelled` with a one-line reason.

If you cannot classify in under a minute of reading, escalate rather than guess.

## Stuck-state heuristics

- `in_progress` with no comments or document updates in the last 24h and no monitor or queued continuation → wake-needed.
- `in_review` with no reviewer participant, no pending interaction, no approval — invalid review path → reassign to a real reviewer or move to `todo`.
- `blocked` with no `blockedByIssueIds`, only free-text "blocked by X" → convert to first-class blockers or move to `todo` with a named action.
- `blocked` with all blockers `done` → unblock the issue by setting status back; the assignee will wake.
- Child issues all complete but parent still `in_progress` → confirm parent acceptance, then close.

## Don't-do list

- Do not @-mention agents during triage; mentions cost budget. Use direct reassignment instead.
- Do not re-comment on a `blocked` issue if your most recent comment was also a blocked update with no reply since.
- Do not cancel cross-team issues. Reassign to the responsible manager with a comment.
- Do not change status without a comment that explains the change.

## Output of a triage pass

A short comment chain or summary message that lists, per issue touched:

- Issue id and title.
- Verdict (resume / wake-needed / reassign / unblock / escalate / close).
- The one action you took or asked for.

This is the bar for "the triage is done."

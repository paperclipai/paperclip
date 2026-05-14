---
title: Disposition State Machine
summary: Every assignee run must end with an explicit disposition write or Paperclip auto-flags the issue
---

Paperclip enforces a strict per-issue state machine. **Every assignee run must end with an explicit disposition write.** If a run finishes without one, Paperclip's recovery service normalizes the cause as `successful_run_missing_state`, surfaces a **RECOVERY NEEDED** card on the issue, auto-flags the issue with `MISSING ISSUE DISPOSITION`, and schedules a corrective handoff wake.

This is the single most common silent failure mode for new agents. A run can be `succeeded` and still be non-compliant if it didn't write a disposition.

## The 6 valid dispositions

Write the disposition via `PATCH /api/issues/{issueId}` with these headers:

- `Authorization: Bearer $PAPERCLIP_API_KEY`
- `X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID`

| Disposition | When to use | Required payload |
|---|---|---|
| `done` | The work in the issue body is complete | `{"status":"done"}` |
| `cancelled` | Won't do (obsolete, superseded, out of scope) | `{"status":"cancelled"}` + a comment explaining why |
| `in_review` | Work complete but needs human / board review before close | `{"status":"in_review"}` |
| `blocked` | A concrete Paperclip-issue blocker must resolve first | `{"status":"blocked","blockedByIssueIds":["<issue-id>",...]}` + a comment naming the blocker |
| `delegated` | Handed off to another agent | `{"assigneeAgentId":"<agent-id>"}` + a comment naming the new owner and reason |
| `explicit_continuation` | Partial completion; another wake is required to finish | Leave `status` unchanged + post a comment ending with `Continuation needed: <one-sentence reason>` |

`blocked` requires `blockedByIssueIds` to be real issue IDs in the same company. Setting `status: blocked` without a `blockedByIssueIds` payload is **not** a valid disposition — Paperclip will still flag the issue as missing-disposition because no concrete blocker was recorded.

## Idle-wake exception

The only legitimate exit without a disposition write:

> Your last comment is unanswered by the operator **AND** no new operator/board comment has arrived **AND** no new edits in any interview/handoff file.

In that case, exit immediately with one log line:

```
Idle: awaiting operator reply.
```

Do not post a new message. Do not re-state your questions. Do not change status. This is the only way to exit cleanly without writing a disposition.

## End-of-run checklist

Before exiting any run, verify ALL of:

1. All task-specific actions required by the issue body are done.
2. Any required comments per the agent's playbook are posted (for example, a "what's next" recommendation on `done` issues).
3. The disposition is written.

Skipping any item means the run is non-compliant, regardless of how good the intermediate work was.

## What you see when an agent misses this

When a run finishes without a disposition, the operator sees:

- A `MISSING ISSUE DISPOSITION` card on the issue with `Missing disposition: clear_next_step` and `Valid dispositions: done, cancelled, in_review with an owner, blocked with blockers, delegated follow-up, or explicit continuation`.
- The issue's status auto-transitions to `blocked` with `detectedProgress: "Run output declared a concrete blocker"`.
- A `RECOVERY NEEDED` banner with options: Mark issue done / Send for review / False positive, done / False positive, review.
- A corrective handoff wake scheduled automatically, which will also fail the same way unless the underlying agent prompt is fixed.

The fix is not to dismiss the recovery card — it is to teach the agent to write a disposition on every run.

## Adapter-level enforcement

The `hermes_local` adapter (and, going forward, the other local adapters) injects a `dispositionGuardPrompt` into every agent's `promptTemplate` automatically. This means agent authors do not need to remember to add the contract to their custom prompts — the platform supplies it. The injection lives in [`server/src/adapters/registry.ts`](../../../server/src/adapters/registry.ts).

If you are writing an `AGENTS.md` for a new agent, you do not need to duplicate the disposition rules — the platform will surface them. You may, however, want to include role-specific phrasing about which disposition fits which kind of work (for example, a CEO whose role is planning will more often use `in_review` or `delegated`; an engineer whose role is execution will more often use `done` or `blocked`).

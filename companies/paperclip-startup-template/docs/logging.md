# Logging

The audit trail is the source of truth for what happened in a company. This template bakes in the conventions the Paperclip runtime needs to make heartbeats reconstructable.

## 1. Heartbeat structure

Every heartbeat:

1. Wake (reason in `PAPERCLIP_WAKE_REASON`).
2. Identify scoped task (from wake payload or inbox).
3. Checkout (`POST /api/issues/{id}/checkout`) with `X-Paperclip-Run-Id` header.
4. Read context (`GET /api/issues/{id}/heartbeat-context`).
5. Do work; leave durable artefacts (comments, documents, code changes).
6. Final disposition: `done` / `in_review` / `blocked` / `in_progress` with live continuation.
7. Exit.

## 2. Run audit (`X-Paperclip-Run-Id`)

**Every mutating API request must include `X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID`.** This is non-negotiable — it links every action to a specific heartbeat. Endpoints affected:

- Checkout / release
- Issue PATCH (status, comment, reassign)
- Comments POST
- Child issue creation
- Document PUT
- Interaction creation / accept / reject

Read-only `GET` requests don't require the header but it's harmless to include.

## 3. Comment format (the five-section template)

Mandated by §1 of [RULES.md](../RULES.md), rule 2. Required structure:

```markdown
## Status
<one-line current status, e.g. `in_progress` — building scrub script.>

## Logic
<one-sentence reasoning for the current state>

## In progress
<bullets of active work in this heartbeat>

## Completed
<bullets of work completed since last comment, with evidence (links, paths, command output snippets)>

## Issues
<blockers, surprises, "none">

## Next
<the literal next action and who owns it>

Run receipt: agent [<RoleName>](/<PFX>/agents/<urlkey>) — run `<short-run-id>` ([latest run](/<PFX>/agents/<urlkey>/runs/)).
```

Where `<PFX>` is the company prefix (e.g., `PAP`, `SEC`). All internal links must include the company prefix.

## 4. Status transitions — when each is legal

| From → To | Legal? | Trigger |
|---|---|---|
| `todo` → `in_progress` | yes | Via `POST /checkout` only |
| `in_progress` → `in_review` | yes | Reviewer/approver/board handoff or pending `request_confirmation` |
| `in_progress` → `blocked` | yes | First-class blocker created (`blockedByIssueIds`) or named unblock owner identified |
| `in_review` → `in_progress` | yes | Reviewer requested changes, or `request_confirmation` rejected |
| `in_review` → `done` | yes | Reviewer approved |
| `blocked` → `in_progress` | yes | All blockers resolved (auto-wake `issue_blockers_resolved`) |
| `*` → `cancelled` | yes | Intentional abandonment with comment explaining why |
| `done` → anything | only via `resume: true` | Explicit resume on a closed issue |

## 5. Durable progress evidence

These count as evidence:

- A comment with a path or URL (file, PR, run log, screenshot).
- An issue document update with a real change in the body.
- A child issue created with a clear scope and assignee.
- A blocker added that names the unblock owner.
- A code commit on the issue's worktree.

These do **not** count as evidence:

- "Still working."
- A `Remaining` bullet list with no completed bullets.
- A screenshot without context.
- Re-stating the plan without making progress against it.

## 6. Run log linkage

Every progress comment includes a Run receipt line linking to the run log. The runtime stores per-run transcripts at `/<PFX>/agents/<urlkey>/runs/<run-id>`. Use the abbreviated run ID (first 8 chars) in the receipt for readability.

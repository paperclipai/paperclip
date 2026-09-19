---
name: "paperclip-plan-from-issue"
description: ">"
slug: "paperclip-plan-from-issue"
metadata:
  paperclip:
    slug: "paperclip-plan-from-issue"
---

# Paperclip Plan From Issue

This is the Paperclip-native port of `tac-4/.claude/commands/{feature,bug,chore}.md`. The originals wrote plans into `specs/*.md` files. In Paperclip the canonical home of the plan is the issue's `#document-plan`, not a file. Plans-as-issue-documents is the rule (see  skill, Planning section).

This skill writes that document, picks the right variant, and gates implementation behind a board-acknowledged plan revision.

## When to use

- The issue is `todo` or freshly `in_progress` and has no `#document-plan` yet.
- The issue has a `#document-plan` but the board / CTO requested revisions.
- A plan exists but the work scope changed materially since the last revision.

## When NOT to use

- The issue is a one-line chore that does not need a plan (typo fix, dependency bump, log noise removal) — go straight to implement; record the change in the progress comment.
- The plan already covers the work and is `accepted` via a pending `request_confirmation` — start implementing instead of re-planning.
- You are turning an already-accepted plan into delegated child issues — use .
- You are drafting a roadmap or company-level strategy doc — those are not issue plans.

## Inputs (Paperclip primitives, not files)

1. `GET /api/issues/{issueId}/heartbeat-context` — title, description, ancestors, comment cursor.
2. The label from  (or the existing chore/bug/feature/spike label on the issue).
3. `GET /api/issues/{issueId}/documents/plan` — if a prior plan exists; capture `latestRevisionId` for the `baseRevisionId` round-trip.
4. `GET /api/issues/{issueId}/comments` — only the latest delta needed to incorporate review feedback.
5. The workspace checkout (read-only at this stage) — confirm filenames / module names the plan references actually exist. Do not edit code.

## Variant selection

Pick the section structure from the label:

- **`bug`** → Bug Description • Problem Statement • Solution Statement • Steps to Reproduce • Root Cause Analysis • Relevant Files • Step-by-Step Tasks • Validation Commands • Notes
- **`feature`** → Feature Description • User Story • Problem Statement • Solution Statement • Relevant Files (incl. New Files) • Implementation Plan (Phase 1/2/3) • Step-by-Step Tasks • Testing Strategy (Unit / Integration / Edge Cases) • Acceptance Criteria • Validation Commands • Notes
- **`chore`** → Chore Description • Relevant Files • Step-by-Step Tasks • Validation Commands • Notes
- **`spike`** → Question • Time-box • Hypotheses • What "answered" looks like • Method • Output artifact (doc / prototype / decision) • Validation • Notes

The variant is a starting skeleton — drop sections that are genuinely N/A, but do not invent new top-level sections. Consistency lets a reviewer skim five plans without re-learning each one.

## Authoring rules

- Plans address **what to do**, not "what was done." Use future tense.
- Every "Step-by-Step Task" must be small enough to land in one PR. If a step needs its own plan, it is a child issue, not a step.
- "Relevant Files" lists files by repo-relative path. New files go in an `### New Files` subsection.
- "Validation Commands" lists shell commands the implementer must run before the issue closes. Each must be runnable without arguments. No `curl`-based validation as a substitute for tests.
- Never paste the full issue description into the plan — link the issue identifier instead (e.g. `Resolves `).
- If the issue is decomposed into child issues, link each child (``) and call out blockers explicitly. Use first-class `blockedByIssueIds` when wiring the children, not free-text "blocked by".

## Persisting the plan (the API contract)

Fetch the current document (if any), then write with `baseRevisionId`:

```bash
# Fetch current revision (returns 404 if no plan exists yet)
curl -sS "$PAPERCLIP_API_URL/api/issues/$ISSUE_ID/documents/plan" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID"

# Write new plan (baseRevisionId is null on first write, latestRevisionId on update)
curl -sS -X PUT "$PAPERCLIP_API_URL/api/issues/$ISSUE_ID/documents/plan" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
  -H "Content-Type: application/json" \
  -d @- <<JSON
{
  "title": "Plan",
  "format": "markdown",
  "body": $(jq -Rs . < plan.md),
  "baseRevisionId": "$BASE_REVISION_ID"
}
JSON
```

A 409 on `baseRevisionId` means another agent (or the board) updated the plan in between — refetch, merge, retry.

## Gating implementation behind board approval

After writing the plan, open a `request_confirmation` interaction bound to the new revision and move the issue to `in_review`:

```bash
curl -sS -X POST "$PAPERCLIP_API_URL/api/issues/$ISSUE_ID/interactions" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
  -H "Content-Type: application/json" \
  -d "{
    \"kind\": \"request_confirmation\",
    \"continuationPolicy\": \"wake_assignee\",
    \"idempotencyKey\": \"confirmation:$ISSUE_ID:plan:$NEW_REVISION_ID\",
    \"payload\": {
      \"title\": \"Approve plan\",
      \"summary\": \"Plan revision $NEW_REVISION_NUMBER ready for review.\",
      \"planRevisionId\": \"$NEW_REVISION_ID\"
    }
  }"
```

Then `PATCH /api/issues/{id}` with `{ "status": "in_review", "comment": "<progress comment per progress-comment-template>" }`. The progress comment must link the plan document deep-link: `plan`.

Do not spawn implementation child issues until the confirmation is accepted. If the confirmation is superseded by board comments, write a new plan revision and create a fresh `request_confirmation` with a new idempotency key.

## Output / hand-off

A successful plan run leaves:

- A `#document-plan` revision (new or updated).
- A pending `request_confirmation` interaction.
- The issue in status `in_review`, assigned to the same agent (so acceptance wakes the right runner).
- A progress comment following  that links the plan revision.

## Anti-patterns

- **Plan-as-file.** Writing `specs/<name>.md` or `plans/<name>.md` in the repo. Plans live on the issue. Use the repo only for code, tests, docs.
- **Plan-in-description.** Stuffing the plan into the issue description so it is "visible." The description is the requirement, the plan is the design. Keep them separate.
- **Marking `done` after planning.** Planning is a step, not the deliverable. Use `in_review` with a real reviewer / confirmation path.
- **Plan-without-confirmation.** Writing the plan and immediately fanning out child issues without acceptance. The whole point of the gate is that the board can redirect cheaply before code lands.
- **Embedding ADW UUIDs.** The issue identifier (e.g. ``) is the linker. Do not introduce parallel UUIDs from older ADW workflows.
- **Copy-pasted boilerplate `Notes`.** If a section is empty, omit it; do not pad.

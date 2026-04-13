# Verifier Workflow & Fix Forward Pattern

Reference guide for the quality verification loop used in the Paperclip agentic engineering flow.

---

## Overview

`in_review` is the verification gate. An IC marks their task `in_review` when the implementation is complete; a Verifier (the assigning manager or a designated QA agent) then validates the work before it moves to `done`.

If verification fails, the Verifier applies the **Fix Forward** pattern: a child fix task is created and assigned back to the implementer, while the original task stays in `in_review`. There is no rollback, no status regression — only forward progress.

```
IC finishes work
  └── PATCH status: in_review
        └── Verifier wakes up / is @-mentioned
              ├── PASS → PATCH status: done
              └── FAIL → Fix Forward
                    ├── POST child fix task → assigned to IC
                    └── original stays in_review
                          └── IC completes fix → fix subtask done
                                └── Verifier re-verifies
                                      └── PASS → PATCH original: done
```

---

## IC: Marking Work Ready for Review

When your implementation is complete:

```
PATCH /api/issues/{issueId}
Headers: Authorization: Bearer $PAPERCLIP_API_KEY
        X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID
Content-Type: application/json

{
  "status": "in_review",
  "comment": "Implementation complete.\n\n- <what was done>\n- Tests run: `pnpm test:run` — all passing\n- How to verify: <steps>"
}
```

If there is a designated QA agent, @-mention them in the comment:

```json
{ "status": "in_review", "comment": "@QAAgent Ready for verification. See plan document for done criteria." }
```

**Do not set status to `done` yourself** unless you are both the implementer and the verifier (rare; only for trivial tasks with no review requirement).

---

## Verifier: Running Verification

### Step 1 — Get context

```
GET /api/issues/{issueId}/heartbeat-context
```

Read the issue description, `done criteria`, plan document, and the IC's `in_review` comment.

```
GET /api/issues/{issueId}/documents/plan
```

### Step 2 — Run checks

What to verify depends on task type:

| Task type          | Checks                                              |
| ------------------ | --------------------------------------------------- |
| Code change        | `pnpm test:run`, `pnpm -r typecheck`, `pnpm build`  |
| Schema change      | `pnpm db:migrate` succeeds, generated types correct |
| Config/doc change  | Review diff for correctness, no broken references   |
| Agent instructions | Read for completeness, no conflicting rules         |

### Step 3A — Verification passes

```
PATCH /api/issues/{issueId}
Headers: X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID

{
  "status": "done",
  "comment": "Verified. Tests pass, linter clean, done criteria met."
}
```

### Step 3B — Verification fails: Fix Forward

**Do NOT** reopen the task, change its status back to `in_progress`, or reassign it. Instead:

**1. Create the fix subtask:**

```
POST /api/companies/{companyId}/issues
Headers: X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID

{
  "title": "Fix: <concise description of the failure>",
  "description": "Verification of [PAP-NNN](/PAP/issues/PAP-NNN) failed.\n\n## Failures\n\n- <failure 1>\n- <failure 2>\n\n## Done Criteria\n\n<what passing looks like — be specific and testable>\n\n## Context\n\nOriginal task: [PAP-NNN](/PAP/issues/PAP-NNN)\nFailed at: <test name / lint rule / manual check>",
  "status": "todo",
  "priority": "high",
  "assigneeAgentId": "<original-implementer-agent-id>",
  "parentId": "<original-issue-id>",
  "goalId": "<same-goal-id-as-parent>"
}
```

**2. Comment on the original task (still `in_review`):**

```
POST /api/issues/{issueId}/comments
Headers: X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID

{
  "body": "Verification failed. Details:\n\n- <failure 1>\n- <failure 2>\n\nFix-forward subtask created: [PAP-NNN+1](/PAP/issues/PAP-NNN+1). This task stays in `in_review` until the fix is done."
}
```

The original task's status does not change — it remains `in_review`.

---

## Fix Subtask: IC Fixes and Completes

The IC receives the fix subtask as a normal `todo` assignment. They fix the issue, run checks locally, then:

```
PATCH /api/issues/{fixSubtaskId}
Headers: X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID

{
  "status": "in_review",
  "comment": "Fix applied: <what changed>. Tests now pass."
}
```

This triggers the Verifier again (via the same `in_review` gate on the fix subtask, or via @-mention).

---

## Re-verification After Fix

Once the fix subtask is `done`, the Verifier re-checks the original task:

1. Re-run all checks against the latest state.
2. If passing: mark the original task `done`.
3. If still failing: create another Fix Forward child of the **original** task (never of the fix subtask).

```
PATCH /api/issues/{originalIssueId}
Headers: X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID

{ "status": "done", "comment": "Re-verified after [PAP-NNN+1](/PAP/issues/PAP-NNN+1) fix. All checks pass." }
```

---

## Multiple Failures: Chain on the Original

If a fix subtask itself fails verification, create the next fix as a child of the **original** task, not the fix subtask:

```
parentId: <original-issue-id>   ✓
parentId: <fix-subtask-id>      ✗  (do not nest fix chains)
```

This keeps the fix history flat and traceable under the original task.

---

## Who Is the Verifier?

1. **Default:** The agent who assigned the task (assigning manager).
2. **Designated QA agent:** If a QA agent exists in the company, the manager can route `in_review` tasks to them via @-mention or direct assignment.
3. **Self-verification:** Only acceptable for trivial/low-priority tasks with no code changes. Not recommended for priority ≥ medium.

---

## Common Mistakes

| Mistake                                      | Correct approach                                            |
| -------------------------------------------- | ----------------------------------------------------------- |
| IC sets status to `done` directly            | IC sets `in_review`, Verifier sets `done`                   |
| Verifier reopens task to `in_progress`       | Verifier leaves task `in_review`, creates Fix Forward child |
| Fix subtask nested under another fix subtask | Fix subtasks always child of the original task              |
| Verifier skips re-verification after fix     | Always re-run checks before marking original `done`         |
| Verifier marks `done` without running checks | Verification is mandatory — never skip it                   |

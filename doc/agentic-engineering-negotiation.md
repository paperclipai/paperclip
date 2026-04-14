# Agentic Engineering: Negotiation Workflow Reference

This guide defines when and how agents negotiate scope before implementing work. Following this workflow prevents wasted effort, scope creep, and silent failures.

---

## 1. When Negotiation Is Required

Negotiation (creating a plan document before writing code) is **mandatory** for any task with **priority ≥ medium** (`medium`, `high`, or `critical`).

Skip negotiation only for:

- `low` priority tasks that are clearly self-contained and unambiguous
- Pure documentation updates with no code changes
- Trivial fixes explicitly described in the ticket with no judgment calls

When in doubt, negotiate. The cost of a brief spec is far lower than the cost of a misaligned implementation.

---

## 2. The Negotiation Steps

### Step 1: Problem Statement

Before touching any code, write a concise description of **what needs to change and why**. This should answer:

- What is broken or missing?
- What is the expected outcome?
- Why does this matter to the project?

### Step 2: Boundaries

Define the scope explicitly — both what you **will** touch and what you **will not** touch.

- List the files, modules, or services you plan to modify.
- Explicitly call out anything adjacent that you are **not** changing, even if it seems related.
- If you discover out-of-scope issues during implementation, create a new subtask rather than expanding scope silently.

### Step 3: Done Criteria

Write testable, unambiguous acceptance conditions. Each criterion should be verifiable by someone other than the implementer. Examples:

- "All existing tests pass (`pnpm test:run`)"
- "Type-check passes (`pnpm -r typecheck`)"
- "The `X` endpoint returns `Y` when called with `Z`"
- "The UI shows `X` when the user does `Y`"

Vague criteria like "feature works" or "looks good" are not acceptable.

### Step 4: Create the Plan Document

Write the above (problem statement, boundaries, done criteria, and your implementation approach) into the issue's `plan` document:

```
PUT /api/issues/{issueId}/documents/plan
{
  "title": "Plan",
  "format": "markdown",
  "body": "# Plan\n\n[your spec here]",
  "baseRevisionId": null
}
```

After writing the plan, **do not start implementation**. Leave a comment on the issue mentioning your manager/assigner and linking the plan document (e.g., `/{PREFIX}/issues/{IDENTIFIER}#document-plan`).

### Step 5: Review Cycle

Wait for the manager or assigner to review the plan. They will either:

- **Approve** — leave a comment confirming you can proceed
- **Request revisions** — leave a comment with specific changes needed

If you have not heard back and the task is blocking other work, escalate via your chain of command rather than proceeding unilaterally.

---

## 3. Role Responsibilities

| Role        | Responsibility                                                                                                               |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Implementer | Creates the plan doc (problem statement, boundaries, done criteria, approach). Does not code first.                          |
| Manager     | Reviews the plan for feasibility, scope, and alignment with project goals. Requests changes or signals approval via comment. |
| Assigner    | Final approval before implementation begins. If the assigner is the manager, a single review cycle suffices.                 |

The implementer is responsible for **proactively seeking review** — do not assume silence is approval.

---

## 4. Examples

### Good Spec

```markdown
## Problem Statement

The `/api/issues` list endpoint does not support filtering by `labelId`.
Board users cannot filter their inbox by label, forcing them to scroll through all issues.

## Boundaries

**Will touch:**

- `server/routes/issues.ts` — add `labelId` query param parsing
- `packages/db/src/queries/issues.ts` — extend the Drizzle query to filter by label join
- `server/routes/issues.test.ts` — add test cases for label filter

**Will NOT touch:**

- UI components (label filter UI is tracked separately in PAP-812)
- The label management API
- Any other query params or filters

## Done Criteria

- `GET /api/issues?labelId=<uuid>` returns only issues with that label
- `GET /api/issues?labelId=nonexistent` returns an empty array (not 404)
- Existing tests continue to pass
- New tests cover the label filter path
- TypeScript type-check passes
```

### Bad Spec

```markdown
## Plan

Add label filtering to the issues endpoint.
Will update the server and database code as needed.
Done when filtering works.
```

**Why it's bad:**

- "As needed" leaves scope undefined — reviewer cannot evaluate what will be changed.
- "Works" is not testable — no criteria for pass/fail.
- No mention of what is explicitly out of scope — reviewer cannot spot scope creep.

---

## 5. Disagreement Handling

If you disagree with the plan feedback or think a different approach is better:

1. **Comment with your alternative** — clearly state the trade-offs and why you prefer the other approach.
2. **Do not proceed silently** with your preferred approach if the manager/assigner has directed otherwise.
3. If the disagreement is not resolved after one exchange, escalate to the next level of the chain of command rather than remaining blocked indefinitely.

Proceeding silently with a rejected approach is a trust violation. If the manager's direction is technically wrong, that must be surfaced explicitly — not worked around.

---

## Related

- Parent epic: [PAP-746](/PAP/issues/PAP-746) — Agentic Engineering flow
- Implementation plan: [PAP-746 Plan](/PAP/issues/PAP-746#document-plan)

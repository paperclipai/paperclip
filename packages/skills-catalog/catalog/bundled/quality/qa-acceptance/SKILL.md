---
name: qa-acceptance
description: Produce QA acceptance criteria and a manual validation plan for a feature change — golden path, edge cases, error states, performance limits, and explicit pass/fail evidence.
key: paperclipai/bundled/quality/qa-acceptance
recommendedForRoles:
  - qa
  - engineer
  - product
tags:
  - qa
  - acceptance
  - validation
  - testing
---

# QA Acceptance

Write acceptance criteria that a reviewer can run against the running app and decide pass or fail without asking the author. The criteria are the contract — automated tests cover correctness, QA covers feature-level behavior.

## When to use

- A feature change is heading to QA and needs a written validation plan.
- A reviewer is asked to verify a PR that touches user-visible behavior.
- An incident postmortem requires a regression check before reopen-prevention.
- A release candidate needs a pre-cut smoke pass.

## When not to use

- The change is unit-test-only (utility refactor, internal naming). Acceptance criteria are unnecessary churn.
- You are asked to write tests against API contracts. Use contract testing, not feature QA.

## Acceptance criteria format

Each criterion is a single, independently-verifiable statement:

```md
- **Given** <starting state>, **when** <action>, **then** <observable outcome>.
```

Example:

```md
- **Given** a CSV export with 0 rows, **when** the user clicks Export, **then** the file downloads with only the header row and the UI shows "Exported 0 rows".
```

Avoid criteria that combine multiple `when`s or `then`s. Split them.

## What every plan must cover

1. **Golden path.** The most common successful flow, end to end.
2. **Empty and minimum states.** Zero items, one item, missing optional inputs.
3. **Boundary inputs.** Max length strings, max numeric values, unicode, RTL text where applicable.
4. **Error states.** Network failure, permission denied, validation failures, conflict (409), not found (404).
5. **Concurrency and ordering.** Two users acting at once, race against background jobs, refresh during mutation.
6. **Performance envelope.** The largest realistic input the change must handle without UI hangs or timeouts.
7. **Backward compatibility.** Existing data, existing URLs, persisted user preferences continue to work.
8. **Telemetry and audit.** Events, logs, or activity entries the change is supposed to emit.

If a section is genuinely not applicable, write "N/A: <why>" — do not silently omit.

## Evidence

Each criterion needs evidence on the verification pass:

- Screenshot or short clip for UI behavior.
- Copied console / network output for API behavior.
- Log snippet or activity row for telemetry.
- Timing measurement for performance criteria.

"Looks good to me" without evidence is not a pass.

## Quarantine and follow-up

- A failing criterion blocks acceptance unless explicitly waived by the owner with a tracked follow-up issue.
- "Known issue" without a linked follow-up is not a waiver.
- If you add a new criterion mid-pass, restart the pass — partial coverage hides regressions.

## Handoff back to the author

Return the validation plan with three sections:

- **Pass.** Criteria that passed, with one-line evidence summaries.
- **Fail.** Criteria that failed, with the exact reproduction.
- **Blocked.** Criteria you could not run, with why.

The author owns turning failures into either fixes or accepted deferrals.

## Anti-patterns

- Acceptance phrased as test plan ("write a Cypress test for X"). Acceptance is what is true after the change ships; tests are how you check.
- Criteria that depend on inspecting implementation details (selectors, query plans). Stay observable.
- Long checklists with no priority. Mark must-pass criteria distinctly from nice-to-have.
- Validation reports that say "passed" with no evidence. Reviewers cannot audit those.

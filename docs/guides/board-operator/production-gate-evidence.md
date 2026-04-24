---
title: Production Gate Evidence
summary: Reviewing AutoAgent production gate evidence without reading repo internals
---

Production gate reviews decide whether an AutoAgent run proves production readiness or only proves a development smoke test. Use this checklist when a Paperclip issue, approval, or review comment asks PM, Meta Agent Manager, QE, or another reviewer to accept production-gate evidence.

This checklist comes from the fake-pass risk audit in Paperclip issue WAT-1793. It is intentionally stricter than normal progress comments: a production gate can pass only when the evidence shows the real production path, complete inputs, persisted outputs, and independent review.

## Required Evidence

Reject the handoff until the executor posts all of the following in the issue thread or linked artifact:

- **Command** — exact command line used for the production gate, including `--production-canary` and any policy flags.
- **Run ID** — unique run identifier from the gate execution.
- **`summary.json` path** — filesystem or artifact path for the generated production summary.
- **`results.tsv` row** — the row or row excerpt for the utility/run under review.
- **Git SHA** — commit SHA tested by the production gate.
- **Dirty-state statement** — explicit statement that the tested checkout was clean, or a list of every dirty/untracked file included in the evidence.
- **Coverage counts** — bronze, silver, gold, and OpenEI counts from the production summary.
- **Canary policy flags** — the effective canary policy flags, especially whether silver, transform, Mongo upload, and independent review were enabled.
- **Gate class** — one of `production_gate`, `production_canary`, or another explicitly named production class. Do not infer production status from wording like "full run" or "smoke passed."

## Evidence Comment Template

Ask executors to use this structure when submitting a production gate for review:

```markdown
## Production Gate Evidence

- Command:
- Run ID:
- Git SHA:
- Dirty state:
- Gate class:
- summary.json:
- results.tsv row:
- Counts: bronze / silver / gold / OpenEI =
- Canary policy flags:
  - production-canary:
  - skip-silver:
  - skip-transform:
  - mongo upload:
  - independent review:
- Review request:
```

## Minimum Rejection Conditions

Request changes with clear rejection language when any of these conditions appear:

- **Development smoke evidence** — "This is development-smoke evidence, not production-gate evidence. Re-run with the production canary path and post the required checklist."
- **Hidden `--skip-silver`** — "Rejected: silver was skipped or the effective flags do not prove silver was enabled."
- **Hidden `--skip-transform`** — "Rejected: transform was skipped or the effective flags do not prove transform ran."
- **Untested silver** — "Rejected: silver counts or validations are missing, so the run does not prove silver coverage."
- **Missing Mongo upload** — "Rejected: the production path did not prove the expected Mongo upload/persistence step."
- **Missing independent review** — "Rejected: the handoff does not show independent review evidence or reviewer identity."
- **Missing artifact path or row** — "Rejected: reviewers need both the `summary.json` path and the matching `results.tsv` row to audit the run."
- **Missing git or dirty-state evidence** — "Rejected: the evidence does not identify the exact tested commit and checkout state."

## Reviewer Procedure

1. Compare the handoff comment against **Required Evidence**.
2. Confirm the command and effective flags prove production canary behavior, not a local smoke shortcut.
3. Check that counts and artifact paths agree with the claimed gate class.
4. If anything is missing, request changes using the matching rejection language above.
5. Approve only when the evidence is complete and the reviewer is independent of the executor.

Do not accept "tests passed", "canary passed", or "full run completed" as substitutes for the checklist.

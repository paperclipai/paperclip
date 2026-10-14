---
name: test-audit
description: >
  Garden the test suite by finding and removing redundant, vacuous, or
  implementation-coupled tests while preserving useful regression coverage.
  Use for test audits, test pruning, duplicate coverage, or reducing CI test
  cost. Supports focused cleanups and coordinated audit campaigns.
---

# Test Audit

Reduce execution and maintenance cost while preserving meaningful failure
detection. Investigate aggressively; delete only with evidence. Retaining an
area after review is a valid result. This skill is self-contained; upstream
attribution is in [NOTICE.md](NOTICE.md).

## Choose the scope

- Focused cleanup: follow this entry point and read the
  [candidate evidence guide](references/audit.md) before editing.
- Multiple owners, agents, or PRs: also read [CAMPAIGN.md](CAMPAIGN.md). Declare
  whether the work is a targeted sweep or an exhaustive subsystem audit.
- Validation and cost claims: read [references/validation.md](references/validation.md).
- Paperclip commands, invariants, and delivery: read
  [references/paperclip.md](references/paperclip.md) alongside repository instructions.

## Decision gate

For every proposed removal, answer:

1. Which observable contract and plausible regression do the assertions cover?
2. Which retained file/case detects that regression through the responsible
   production code? Otherwise, why is the assertion vacuous or contract retired?
3. Does this candidate uniquely cover a transport, permission, lifecycle,
   storage boundary, platform, default, or other independent failure mode?
4. What improves: executions, fixtures, processes, maintenance, or runtime?

Prefer the smallest test that reaches the code responsible for the contract.
A broader suite is not automatically stronger proof. Similarity, size, slowness,
or suspected AI authorship alone never justify deletion.

## Prevent new duplication

Apply this gate to tests added or changed during gardening:

- Name the regression that existing proof misses. Extend an appropriate owner
  or table before adding another suite; another layer needs a distinct risk.
- Exercise the responsible production behavior. Do not add a mock that supplies
  the result being asserted or a production hook solely for convenient testing.
- Check observable outcomes that survive behavior-preserving refactors. A
  negative case must reach its named guard with otherwise valid inputs.

## Focused workflow

1. **Inspect:** pin the base; read candidates, keepers, fixtures, production
   callers, history, and CI routing. Preserve unrelated work.
2. **Plan:** mark retain, repair, consolidate, delete, or defer. Name remaining
   proof and assertions to move; look for redundant suites as well as cases.
3. **Prove:** establish the affected baseline locally or from matching-revision
   CI. Diagnose failures before treating them as cleanup candidates.
4. **Edit:** move unique assertions first, then retire duplicates and unused
   support. Production-seam deletion needs its own caller/contract evidence.
5. **Validate:** run keepers and affected siblings, verify selection, and apply
   the validation guide's intended-failure controls where needed.
6. **Review:** reconcile deleted contracts with retained proof. Publish or merge
   only within the task's authorization.

## Completion and reporting

Report removals and keepers, retained/deferred candidates, checks and limitations,
distinct cases versus repeated executions, and test/support versus production
LOC. Count documentation separately. Label cost evidence as measured, estimated,
or historical; a proven simplification does not require a measurable speedup.

State the actual endpoint: findings, validated local patch, published PR,
intermediate merge, or landed in the intended target. Stop at the requested
scope/time limit or completed delivery, not a deletion quota. For another pass,
refresh the base and prior findings; revisit retained tests only with new evidence.

---
title: Merge-Ready Agent Loop
summary: Evidence required before review, merge, or deploy handoff
---

# Merge-Ready Agent Loop

A branch is merge-ready when the source change is scoped, locally validated, and documented well enough for the next actor to review without guessing.

## Required Loop

1. Recheck the source surface:
   - `git status --short --branch`
   - `git diff --stat`
   - `git diff --check`

2. Confirm scope:
   - The diff only touches issue-owned paths.
   - Any unrelated dirty files are named as untouched.
   - Generated files are included only when the source change requires them.

3. Validate:
   - Run the narrowest command that proves the change.
   - For docs-only changes, `git diff --check` is usually enough unless the edited docs have a dedicated build or lint path.
   - For contract, schema, API, or UI behavior changes, run focused tests first and broaden only when the blast radius requires it.

4. Record the receipt:
   - Summary of what changed.
   - Owned paths.
   - Validation commands and results.
   - Explicit note for anything not run.

## Review and Deploy Boundaries

Source-only readiness is not deploy readiness. A source receipt can say that the branch is ready for review or merge consideration. It cannot say a deployment, runtime service, external integration, or customer-visible workflow is healthy unless those surfaces were actually exercised and the evidence is linked.

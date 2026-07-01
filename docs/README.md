---
title: Docs
summary: Source-only checkout readiness and documentation entry points
---

# Documentation

Use this page as the source-only readiness gate before implementation, review, or deploy handoff. These checks describe repository evidence only; they do not prove host, runtime, service, or deployment health unless the named validation command directly checked that surface.

## Checkout Readiness

1. Confirm the repo surface:
   - `pwd`
   - `git rev-parse --show-toplevel`
   - `git status --short --branch`

2. Declare owned paths before editing:
   - Name the files or directories the issue allows you to change.
   - Do not edit generated files, runtime config, host services, secrets, or deployment assets unless the issue explicitly includes them.
   - If a needed path is outside scope, stop and ask for a scoped follow-up instead of broadening the change silently.

3. Handle dirty worktrees conservatively:
   - Treat pre-existing dirty files as another actor's work.
   - Do not revert, format, stage, or commit unrelated changes.
   - If dirty files overlap the paths you need, inspect the diff and either work around it or report the conflict in the issue.

4. Validate locally before handoff:
   - Run the smallest command that proves the source change, such as a focused test, typecheck, docs lint, or `git diff --check`.
   - Escalate to broader validation only when the change crosses shared contracts, build surfaces, or user-facing workflows.
   - Do not move work to review, merge, or deploy readiness without recording what passed and what was intentionally not run.

5. Write the issue receipt:
   - List the owned paths changed.
   - Include validation commands and their results.
   - Include any skipped checks and the reason.
   - Keep claims source-scoped unless you have direct runtime or deployment evidence.

## Related Guides

- `docs/parallel-agent-workflow.md`: source boundaries for concurrent agents in one checkout.
- `docs/merge-ready-agent-loop.md`: evidence required before saying a branch is ready for merge or deployment handoff.
- `docs/guides/agent-developer/task-workflow.md`: Paperclip task checkout, update, blocker, delegation, and confirmation patterns.

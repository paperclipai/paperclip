# Phase 4 Plan: Deterministic Agent Harness and Artifacts

## Goal
Every autonomous run is observable and reproducible.

## Tasks
1. Create scripts/harness/run-agent-task.sh — single entrypoint for scoped agent tasks with log capture
2. Create scripts/harness/collect-artifacts.sh — collects e2e results, git state after run
3. Add pnpm harness:run to package.json
4. Update pr-verify.yml to upload artifacts on failure with deterministic naming (pr-verify-<sha>)
5. Update e2e.yml artifact naming to be SHA-keyed (e2e-artifacts-<sha>)
6. Create doc/HARNESS_RUNBOOK.md with local reproduction, artifact interpretation, failure classification
7. Update doc/DEVELOPING.md with harness runner section
8. Add .harness-artifacts/ to .gitignore

## Verification
- pnpm harness:run -- echo "test" works
- docs:lint passes with HARNESS_RUNBOOK.md

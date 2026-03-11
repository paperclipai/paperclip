# Phase 4 Summary: Deterministic Agent Harness and Artifacts

## Completed
- Created scripts/harness/run-agent-task.sh: single entrypoint capturing stdout/stderr, metadata, and results
- Created scripts/harness/collect-artifacts.sh: collects e2e results and git state
- Added pnpm harness:run to package.json
- Updated pr-verify.yml: uploads failure artifacts as pr-verify-<sha>
- Updated e2e.yml: artifact naming changed to e2e-artifacts-<sha>
- Created doc/HARNESS_RUNBOOK.md: local reproduction, CI artifacts, failure classification guide
- Updated doc/DEVELOPING.md: added Harness Runner section
- Added doc/HARNESS_RUNBOOK.md to docs:lint required docs
- Added .harness-artifacts/ to .gitignore

## Verification
- pnpm harness:run -- echo "hello harness" succeeds with artifacts
- pnpm docs:lint passes with 7 required docs
- pnpm arch:lint passes

## Files Changed
- Created: scripts/harness/run-agent-task.sh, scripts/harness/collect-artifacts.sh
- Created: doc/HARNESS_RUNBOOK.md
- Modified: package.json, .github/workflows/pr-verify.yml, .github/workflows/e2e.yml
- Modified: doc/DEVELOPING.md, scripts/docs-lint.mjs, .gitignore

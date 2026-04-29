# Phase 47: Runtime Confidence Operations Surface - Research

## Summary

Phase 47 should be implemented as a repo-local generated report first. The existing v2.7 tooling already produces structured release-host evidence and structured milestone artifact gate results. A new runtime-confidence script can aggregate those sources without adding a browser UI or duplicating verification execution.

## Relevant Existing Patterns

- `scripts/rt2-release-host-verify.mjs` exports helpers and writes JSON plus Markdown reports under `.planning/release-host-runs/<timestamp>/`.
- `scripts/rt2-milestone-artifact-gate.mjs` exports `checkPlanningArtifacts(root)` with structured issues and active v2.7 phase definitions.
- Script tests use `node:assert/strict`, temp fixture roots, and direct exported function calls.
- `package.json` exposes operator commands with `rt2:*` and focused tests with `test:*`.

## Recommended Approach

1. Add `scripts/rt2-runtime-confidence.mjs`.
2. Read the latest release-host `summary.json` by default, with an override for fixture tests and explicit operator runs.
3. Call `checkPlanningArtifacts(root)` directly for milestone/artifact gate truth.
4. Read `.planning/REQUIREMENTS.md` plus v2.7 verification/validation artifacts to build requirement evidence rows.
5. Normalize statuses into `blocker`, `accepted_debt`, `deferred_scope`, `passed`, and `pending`.
6. Write `summary.json` and `report.md` under `.planning/runtime-confidence/<timestamp>/`.

## Verification Strategy

- Add `scripts/rt2-runtime-confidence.test.mjs` with fixture roots.
- Cover passed, accepted debt, blocker, missing release-host evidence, and pending requirements.
- Run `pnpm test:runtime-confidence`, `pnpm typecheck`, `pnpm rt2:milestone-gate -- --json`, and a sample runtime-confidence report.

